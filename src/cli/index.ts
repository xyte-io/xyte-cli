import { createInterface } from 'node:readline/promises';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';

import { Command } from 'commander';

import { readCliActionLog } from './action-log-store';
import { runActionLogViewer } from './action-log-viewer';
import {
  gcCliActionLogFiles,
  listCliActionLogFiles,
  createCliActionLogger,
  extractCommandPathFromLogEntry,
  resolveCliActionLogPath,
  sanitizeArgvForLog,
  type CliActionLogEntry,
  type CliActionLogger
} from './action-logger';
import { createXyteClient } from '../client/create-client';
import { getEndpoint, listEndpoints } from '../client/catalog';
import { buildCallEnvelope } from '../contracts/call-envelope';
import { toProblemDetails } from '../contracts/problem';
import { buildStatusContract, type StatusMode } from '../contracts/status';
import type { WatchFrameV1 } from '../contracts/watch-frame';
import { evaluateReadiness, type ReadinessCheck } from '../config/readiness';
import {
  SUPPORTED_SETTING_KEYS,
  parseSettingValue,
  resolveCliSettingsSync,
  setCliSettingSync,
  unsetCliSettingSync,
  type CliTextJsonOutputMode,
  type ResolvedCliSettingsState,
  type SettingKey,
  type SettingsScope
} from '../config/settings';
import { createSecretStore, type SecretStore } from '../secure/secret-store';
import { makeKeyFingerprint, matchesSlotRef } from '../secure/key-slots';
import { FileProfileStore, type ProfileStore } from '../secure/profile-store';
import type { SecretProvider } from '../types/profile';
import { SUPPORTED_SECRET_PROVIDERS, isSecretProvider } from '../types/profile';
import { parseJsonObject } from '../utils/json';
import { stringifyJsonOutput } from '../utils/json-output';
import type { UtilityInputFormat } from '../utils/input-parser';
import { resolveCommandFromPath } from '../utils/resolve-command-path';
import { getCliVersion } from '../utils/version';
import {
  installSkills,
  type SkillAgent,
  type SkillInstallOutcome,
  type SkillInstallScope
} from '../utils/install-skills';
import { applyUpgrade, checkForUpgrade, type UpgradeDependencies } from '../utils/upgrade';
import { runTuiApp } from '../tui/app';
import type { TuiScreenId } from '../tui/types';
import {
  buildDeepDive,
  buildFleetInspect,
  collectFleetSnapshot,
  formatDeepDiveAscii,
  formatDeepDiveMarkdown,
  formatFleetInspectAscii,
  generateFleetReport,
  parseDeepDiveForReport,
  type InspectProviderScope
} from '../workflows/fleet-insights';
import {
  getBuiltInFlowDefinition,
  hasBuiltInFlowDefinition,
  listBuiltInFlowDefinitions
} from '../workflows/flow-catalog';
import { parseFlowVarOptions, runDeterministicFlow, type FlowRunMode } from '../workflows/flow-runner';
import {
  exportFlowDefinition,
  getFlowDefinition,
  importFlowDefinition,
  listFlowDefinitions,
  saveFlowDefinition,
  updateFlowDefinition
} from '../workflows/flow-user-definitions';
import { runWatch } from '../workflows/watch';
import { buildUtilityPrepare, listUtilityPrepareActions } from '../workflows/utility-prepare';
import type { UtilityPreparePrimaryFormat } from '../workflows/utility-action-profiles';
import { runSpaceImportTree } from '../workflows/utility-commands';
import { CliUserError } from './user-error';

type OutputStream = Pick<typeof process.stdout, 'write'>;
type ErrorStream = Pick<typeof process.stderr, 'write'>;
type OutputFormat = 'json' | 'text';
type PromptValueFn = (args: { question: string; initial?: string; stdout: OutputStream; secret?: boolean }) => Promise<string>;
type SetupConnectivityMode = 'auto' | 'always' | 'never';
type SetupStepKey =
  | 'tenant_upserted'
  | 'tenant_activated'
  | 'slot_written'
  | 'slot_activated'
  | 'connectivity_checked'
  | 'readiness_evaluated';

interface SetupStep {
  key: SetupStepKey;
  status: 'ok' | 'skipped';
  detail?: string;
}

interface InstallDoctorResult {
  status: 'ok' | 'missing' | 'mismatch';
  commandOnPath: boolean;
  commandPath?: string;
  commandRealPath?: string;
  expectedPath: string;
  expectedRealPath: string;
  sameTarget: boolean;
  suggestions: string[];
}

interface CliGlobalOptions {
  output?: CliTextJsonOutputMode;
  logActions?: boolean;
  logActionsPath?: string;
  logActionsVerbose?: boolean;
}

interface ActiveCliAction {
  commandPath: string;
  startedAt: number;
}

interface CliActionLogState {
  logger?: CliActionLogger;
  activeAction?: ActiveCliAction;
  verbose?: boolean;
}

// Use a symbol to avoid collisions with Commander internals or plugin-added properties.
const CLI_ACTION_LOG_STATE = Symbol('xyte-cli-action-log-state');

type CliProgramWithActionLogState = Command & {
  [CLI_ACTION_LOG_STATE]?: () => CliActionLogState;
};

interface CliRuntime {
  profileStore?: ProfileStore;
  secretStore?: SecretStore;
  stdout?: OutputStream;
  stderr?: ErrorStream;
  runTui?: typeof runTuiApp;
  promptValue?: PromptValueFn;
  readStdinValue?: () => Promise<string>;
  isTTY?: boolean;
  stdoutIsTTY?: boolean;
  upgradeDependencies?: UpgradeDependencies;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface SlotView {
  tenantId: string;
  provider: SecretProvider;
  slotId: string;
  name: string;
  fingerprint: string;
  hasSecret: boolean;
  active: boolean;
  lastValidatedAt?: string;
}

const SIMPLE_SETUP_AUTH_PROVIDER = 'xyte-org' as const;
const SIMPLE_SETUP_SLOT_NAME = 'primary';
const SIMPLE_SETUP_DEFAULT_TENANT = 'default';
const SKILL_AGENTS: SkillAgent[] = ['claude', 'copilot', 'codex'];
const SKILL_SCOPES: SkillInstallScope[] = ['project', 'user', 'both'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseBooleanEnvFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function parsePositiveIntegerEnv(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function commandPathFor(command: Command): string {
  const names: string[] = [];
  let current: Command | undefined = command;
  while (current) {
    const name = current.name();
    if (name) {
      names.unshift(name);
    }
    current = current.parent ?? undefined;
  }
  return names.join(' ');
}

function getExplicitGlobalOutput(command: Command): CliTextJsonOutputMode | undefined {
  const source = command.getOptionValueSourceWithGlobals('output');
  if (!source || source === 'default') {
    return undefined;
  }
  const options = command.optsWithGlobals() as { output?: string };
  return parseCliTextJsonOutputMode(options.output);
}

function argvForCommand(command: Command): string[] {
  let root: Command = command;
  while (root.parent) {
    root = root.parent;
  }

  const rootWithRawArgs = root as Command & { rawArgs?: string[] };
  const rawArgs = Array.isArray(rootWithRawArgs.rawArgs) ? rootWithRawArgs.rawArgs : process.argv;
  if (!Array.isArray(rawArgs) || rawArgs.length <= 2) {
    return [];
  }
  return rawArgs.slice(2);
}

function parsePositiveIntegerOption(value: string | undefined, fallback: number, label: string): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}. Use a positive integer.`);
  }
  return parsed;
}

function parsePositiveNumberOption(value: string | undefined, fallback: number | undefined, label: string): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}. Use a positive number.`);
  }
  return parsed;
}

function firstNonEmptyString(values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function extractTenantNameFromOrganizationInfo(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const nameKeys = ['name', 'organization_name', 'display_name', 'tenant_name', 'company_name'] as const;
  const readName = (record: Record<string, unknown>): string | undefined =>
    firstNonEmptyString(nameKeys.map((key) => record[key]));

  const candidates: Record<string, unknown>[] = [payload];
  const directNested = [payload.organization, payload.data, payload.result, payload.payload].filter(isRecord) as Record<string, unknown>[];
  candidates.push(...directNested);
  for (const nested of directNested) {
    if (isRecord(nested.organization)) {
      candidates.push(nested.organization);
    }
  }

  for (const candidate of candidates) {
    const name = readName(candidate);
    if (name) {
      return name;
    }
  }

  return undefined;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let size = bytes / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

function formatActionLogText(entry: CliActionLogEntry): string {
  const commandPath = extractCommandPathFromLogEntry(entry) ?? '-';
  const data = isRecord(entry.data) ? entry.data : undefined;
  const duration = typeof data?.durationMs === 'number' && Number.isFinite(data.durationMs) ? `${Math.round(data.durationMs)}ms` : '-';
  return `${entry.timestamp} | ${entry.level} | ${entry.event} | ${commandPath} | ${duration}`;
}

function inferCommandPathFromArgv(argv: string[]): string {
  if (argv.length < 2) {
    return 'xyte-cli';
  }

  const commandParts: string[] = [];
  for (const token of argv.slice(1)) {
    if (!token || token.startsWith('-')) {
      continue;
    }
    commandParts.push(token);
    if (commandParts.length >= 3) {
      break;
    }
  }

  if (!commandParts.length) {
    return 'xyte-cli';
  }
  return commandParts.join(' ');
}

function resolveSkillSourceDir(): string {
  return path.resolve(__dirname, '../../skills/xyte-cli');
}

function renderJsonOutput(value: unknown, options: { strictJson?: boolean; compact?: boolean } = {}): string {
  return `${stringifyJsonOutput(value, { strictJson: options.strictJson, compact: options.compact })}\n`;
}

function printJson(stream: OutputStream, value: unknown, options: { strictJson?: boolean; compact?: boolean } = {}) {
  stream.write(renderJsonOutput(value, options));
}

function resolveOutPath(out: string | undefined): string | undefined {
  return out ? path.resolve(out) : undefined;
}

function ensureParentDir(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeRenderedOutput(stream: OutputStream, text: string, outPath?: string): void {
  stream.write(text);
  if (outPath) {
    ensureParentDir(outPath);
    writeFileSync(outPath, text, 'utf8');
  }
}

function appendRenderedOutput(stream: OutputStream, text: string, outPath?: string): void {
  stream.write(text);
  if (outPath) {
    ensureParentDir(outPath);
    appendFileSync(outPath, text, 'utf8');
  }
}

function resolveFieldValue(value: unknown, field: string): unknown {
  const segments = field
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean);
  let current = value;
  for (const segment of segments) {
    if (!isRecord(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function formatScalarFieldValue(value: unknown, field: string): string {
  if (value === undefined || Array.isArray(value) || isRecord(value)) {
    throw new CliUserError({
      summary: 'Invalid setup status field.',
      cause: `Field "${field}" is missing or not a scalar value.`,
      suggestedCommands: ['Use --field tenantId', 'Omit --field to print the full status payload']
    });
  }
  return value === null ? 'null' : String(value);
}

function createSecretConflictError(cause: string): CliUserError {
  return new CliUserError({
    summary: 'Conflicting API key sources.',
    cause,
    suggestedCommands: ['Use exactly one of --key, --key-stdin, or XYTE_CLI_KEY']
  });
}

function parseProvider(value: string): SecretProvider {
  if (!isSecretProvider(value)) {
    throw new Error(`Invalid provider: ${value}`);
  }
  return value;
}

function parseSkillInstallScope(value: string | undefined): SkillInstallScope | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (!SKILL_SCOPES.includes(normalized as SkillInstallScope)) {
    throw new Error(`Invalid scope: ${value}. Expected one of: ${SKILL_SCOPES.join(', ')}.`);
  }
  return normalized as SkillInstallScope;
}

function parseSkillAgents(value: string | undefined): SkillAgent[] | undefined {
  if (!value) {
    return undefined;
  }

  const tokens = value
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  if (!tokens.length) {
    throw new Error('Invalid agents: empty value.');
  }

  if (tokens.includes('all')) {
    if (tokens.length > 1) {
      throw new Error('Invalid agents: "all" cannot be combined with specific agents.');
    }
    return [...SKILL_AGENTS];
  }

  const unknown = tokens.filter((item) => !SKILL_AGENTS.includes(item as SkillAgent));
  if (unknown.length > 0) {
    throw new Error(`Invalid agents: ${unknown.join(', ')}. Expected "all" or ${SKILL_AGENTS.join(', ')}.`);
  }

  return SKILL_AGENTS.filter((agent) => tokens.includes(agent));
}

function formatInstallOutcome(outcome: SkillInstallOutcome): string {
  const prefix = `${outcome.scope}/${outcome.agent}`;
  if (outcome.status === 'failed') {
    return `- ${prefix}: failed -> ${outcome.targetDir} (${outcome.error ?? 'unknown error'})`;
  }
  if (outcome.status === 'skipped') {
    return `- ${prefix}: skipped -> ${outcome.targetDir} (already exists; use --force to overwrite)`;
  }
  return `- ${prefix}: ${outcome.status} -> ${outcome.targetDir}`;
}

function parsePathJson(value: string | undefined): Record<string, string | number> {
  const record = parseJsonObject(value);
  const out: Record<string, string | number> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' || typeof item === 'number') {
      out[key] = item;
      continue;
    }
    throw new Error(`Path parameter "${key}" must be string or number.`);
  }
  return out;
}

function parseQueryJson(value: string | undefined): Record<string, string | number | boolean | null | undefined> {
  const record = parseJsonObject(value);
  const out: Record<string, string | number | boolean | null | undefined> = {};
  for (const [key, item] of Object.entries(record)) {
    if (item === null || item === undefined || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      out[key] = item as string | number | boolean | null | undefined;
      continue;
    }
    throw new Error(`Query parameter "${key}" must be scalar, null, or undefined.`);
  }
  return out;
}

function parseUtilityInputFormat(value: string | undefined): UtilityInputFormat {
  const normalized = (value ?? 'auto').trim().toLowerCase();
  const allowed: UtilityInputFormat[] = ['auto', 'csv', 'json', 'jsonl'];
  if (!allowed.includes(normalized as UtilityInputFormat)) {
    throw new Error(`Invalid input format: ${value}. Use auto|csv|json|jsonl.`);
  }
  return normalized as UtilityInputFormat;
}

function parseUtilityPreparePrimaryFormat(value: string | undefined): UtilityPreparePrimaryFormat | undefined {
  if (!value || !value.trim()) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'csv' && normalized !== 'jsonl') {
    throw new Error(`Invalid primary format: ${value}. Use csv|jsonl.`);
  }
  return normalized as UtilityPreparePrimaryFormat;
}

function parseStatusMode(value: string | undefined): StatusMode {
  const normalized = (value ?? 'fast').trim().toLowerCase();
  if (normalized !== 'fast' && normalized !== 'full') {
    throw new Error(`Invalid status mode: ${value}. Use fast|full.`);
  }
  return normalized as StatusMode;
}

function parseSetupConnectivityMode(value: string | undefined): SetupConnectivityMode {
  const normalized = (value ?? 'auto').trim().toLowerCase();
  if (normalized !== 'auto' && normalized !== 'always' && normalized !== 'never') {
    throw new Error(`Invalid connectivity mode: ${value}. Use auto|always|never.`);
  }
  return normalized as SetupConnectivityMode;
}

function parseWatchProfile(value: string | undefined): 'incidents-active' {
  const normalized = (value ?? 'incidents-active').trim().toLowerCase();
  if (normalized !== 'incidents-active') {
    throw new Error(`Invalid watch profile: ${value}. Use incidents-active.`);
  }
  return 'incidents-active';
}

function parseWatchIntervalMs(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '2000', 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid interval: ${value}.`);
  }
  if (parsed < 1000) {
    throw new Error(`Invalid interval: ${parsed}. Minimum is 1000ms.`);
  }
  return parsed;
}

function parseWatchMaxPolls(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid max-polls: ${value}. Use a positive integer.`);
  }
  if (parsed > 3600) {
    throw new Error(`Invalid max-polls: ${value}. Maximum is 3600.`);
  }
  return parsed;
}

function parseFlowMode(options: { plan?: boolean; apply?: boolean }): FlowRunMode {
  const plan = options.plan === true;
  const apply = options.apply === true;
  if (plan && apply) {
    throw new Error('Invalid mode: use only one of --plan or --apply.');
  }
  if (apply) {
    return 'apply';
  }
  return 'plan';
}

function parseInspectProviderScope(value: string | undefined): InspectProviderScope {
  const normalized = (value ?? 'auto').trim().toLowerCase();
  if (normalized !== 'auto' && normalized !== 'organization' && normalized !== 'partner') {
    throw new Error(`Invalid inspect provider scope: ${value}. Use organization|partner|auto.`);
  }
  return normalized as InspectProviderScope;
}

function parseFlowContextJson(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }
  const resolvedPath = path.resolve(value);
  const rawText = readFileSync(resolvedPath, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(rawText) as unknown;
  } catch {
    throw new Error(`Invalid flow context file: ${resolvedPath}. Expected valid JSON.`);
  }
  if (!isRecord(raw)) {
    throw new Error(`Invalid flow context file: ${resolvedPath}. Expected a JSON object.`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(raw)) {
    if (item === null || item === undefined) {
      continue;
    }
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      out[key] = String(item);
      continue;
    }
    throw new Error(`Invalid flow context value for "${key}". Use scalar string/number/boolean values.`);
  }
  return out;
}

function isMutatingMethod(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function formatReadinessText(readiness: ReadinessCheck): string {
  const lines: string[] = [];
  lines.push(`Readiness: ${readiness.state}`);
  lines.push(`Tenant: ${readiness.tenantId ?? 'none'}`);
  lines.push(`Connectivity: ${readiness.connectionState} (${readiness.connectivity.message})`);
  lines.push('');
  lines.push('Providers:');

  for (const provider of readiness.providers) {
    lines.push(
      `- ${provider.provider}: slots=${provider.slotCount}, active=${provider.activeSlotId ?? 'none'} (${provider.activeSlotName ?? 'n/a'}), hasSecret=${provider.hasActiveSecret}`
    );
  }

  if (readiness.missingItems.length) {
    lines.push('');
    lines.push('Missing items:');
    readiness.missingItems.forEach((item) => lines.push(`- ${item}`));
  }

  if (readiness.recommendedActions.length) {
    lines.push('');
    lines.push('Recommended actions:');
    readiness.recommendedActions.forEach((item) => lines.push(`- ${item}`));
  }

  return `${lines.join('\n')}\n`;
}

function formatSlotListText(slots: SlotView[]): string {
  if (!slots.length) {
    return 'No key slots found.\n';
  }

  const lines: string[] = ['tenant | provider | slotId | name | active | hasSecret | fingerprint | lastValidatedAt'];
  for (const slot of slots) {
    lines.push(
      `${slot.tenantId} | ${slot.provider} | ${slot.slotId} | ${slot.name} | ${slot.active} | ${slot.hasSecret} | ${slot.fingerprint} | ${
        slot.lastValidatedAt ?? 'n/a'
      }`
    );
  }
  return `${lines.join('\n')}\n`;
}

function getRealPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function runInstallDoctor(): InstallDoctorResult {
  const expectedPath = path.resolve(__dirname, '../../dist/bin/xyte-cli.js');
  const expectedRealPath = getRealPath(expectedPath);
  const commandPath = resolveCommandFromPath('xyte-cli');
  const commandOnPath = Boolean(commandPath);
  const commandRealPath = commandPath ? getRealPath(commandPath) : undefined;
  const sameTarget = Boolean(commandRealPath && commandRealPath === expectedRealPath);

  const suggestions: string[] = [];
  if (!commandOnPath) {
    suggestions.push('Run: npm run install:global');
    suggestions.push('Then verify from a different directory: xyte-cli --help');
  } else if (!sameTarget) {
    suggestions.push(`xyte-cli currently points to: ${commandPath}`);
    suggestions.push('Relink this repo globally: npm run reinstall:global');
  } else {
    suggestions.push('Global command wiring looks correct.');
  }

  const status: InstallDoctorResult['status'] = !commandOnPath ? 'missing' : sameTarget ? 'ok' : 'mismatch';
  return {
    status,
    commandOnPath,
    commandPath,
    commandRealPath,
    expectedPath,
    expectedRealPath,
    sameTarget,
    suggestions
  };
}

async function promptValue(args: { question: string; initial?: string; stdout: OutputStream; secret?: boolean }): Promise<string> {
  const mutedOutput = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
  const rl = createInterface({
    input: process.stdin,
    output: args.secret ? mutedOutput : process.stdout,
    terminal: true
  });
  try {
    const suffix = args.initial ? ` [${args.initial}]` : '';
    if (args.secret) {
      args.stdout.write(`${args.question}${suffix}: `);
    }
    const answer = (await rl.question(args.secret ? '' : `${args.question}${suffix}: `)).trim();
    if (args.secret) {
      args.stdout.write('\n');
    }
    return answer || args.initial || '';
  } finally {
    rl.close();
  }
}

async function readStdinValue(): Promise<string> {
  const chunks: string[] = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return chunks.join('').trim();
}

function normalizeTenantId(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized || SIMPLE_SETUP_DEFAULT_TENANT;
}

async function resolveSlotByRef(
  profileStore: ProfileStore,
  tenantId: string,
  provider: SecretProvider,
  slotRef: string
) {
  const slots = await profileStore.listKeySlots(tenantId, provider);
  const slot = slots.find((item) => matchesSlotRef(item, slotRef));
  if (!slot) {
    throw new Error(`Unknown slot "${slotRef}" for provider ${provider} in tenant ${tenantId}.`);
  }
  return slot;
}

async function collectSlotViews(args: {
  profileStore: ProfileStore;
  secretStore: SecretStore;
  tenantId: string;
  provider?: SecretProvider;
}): Promise<SlotView[]> {
  const slots = await args.profileStore.listKeySlots(args.tenantId, args.provider);
  const groupedProviders = new Set(slots.map((slot) => slot.provider));
  const activeByProvider = new Map<SecretProvider, string | undefined>();
  for (const provider of groupedProviders) {
    const active = await args.profileStore.getActiveKeySlot(args.tenantId, provider);
    activeByProvider.set(provider, active?.slotId);
  }

  const views: SlotView[] = [];
  for (const slot of slots) {
    const hasSecret = Boolean(await args.secretStore.getSlotSecret(args.tenantId, slot.provider, slot.slotId));
    views.push({
      tenantId: args.tenantId,
      provider: slot.provider,
      slotId: slot.slotId,
      name: slot.name,
      fingerprint: slot.fingerprint,
      hasSecret,
      active: activeByProvider.get(slot.provider) === slot.slotId,
      lastValidatedAt: slot.lastValidatedAt
    });
  }
  return views;
}

async function resolveKeyValue(args: {
  key?: string;
  keyStdin?: boolean;
  envKey?: string;
  allowPrompt?: boolean;
  prompt: PromptValueFn;
  readStdin: () => Promise<string>;
  promptQuestion: string;
  stdout: OutputStream;
}): Promise<string | undefined> {
  const inlineKey = args.key?.trim();
  const envKey = args.envKey?.trim();

  if (inlineKey && args.keyStdin) {
    throw createSecretConflictError('Use either --key or --key-stdin, not both.');
  }
  if (args.keyStdin && envKey) {
    throw createSecretConflictError('Use either --key-stdin or XYTE_CLI_KEY, not both.');
  }
  if (inlineKey) {
    return inlineKey;
  }
  if (args.keyStdin) {
    const stdinValue = (await args.readStdin()).trim();
    return stdinValue || undefined;
  }
  if (envKey) {
    return envKey;
  }
  if (args.allowPrompt) {
    const prompted = await args.prompt({
      question: args.promptQuestion,
      stdout: args.stdout,
      secret: true
    });
    return prompted.trim() || undefined;
  }
  return undefined;
}

function parseCliTextJsonOutputMode(value: string | undefined): CliTextJsonOutputMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized !== 'auto' && normalized !== 'json' && normalized !== 'text') {
    throw new CliUserError({
      summary: 'Invalid output mode.',
      cause: `Received "${value}".`,
      suggestedCommands: ['Use --output auto', 'Use --output json', 'Use --output text']
    });
  }
  return normalized as CliTextJsonOutputMode;
}

function resolveTextJsonOutput(args: {
  output?: string;
  format?: string;
  stdoutIsTTY: boolean;
  settings: ResolvedCliSettingsState;
}): OutputFormat {
  const explicitOutput = parseCliTextJsonOutputMode(args.output);
  const localFormat = args.format?.trim().toLowerCase();
  if (localFormat) {
    if (localFormat !== 'json' && localFormat !== 'text') {
      throw new CliUserError({
        summary: 'Invalid format.',
        cause: `Received "${args.format}".`,
        suggestedCommands: ['Use --output json', 'Use --output text']
      });
    }
    return localFormat;
  }

  const mode = explicitOutput ?? args.settings.values.output.mode;
  if (mode === 'auto') {
    return args.stdoutIsTTY ? 'text' : 'json';
  }
  return mode;
}

function resolveStrictJson(args: { strictJson?: boolean; settings: ResolvedCliSettingsState }): boolean {
  if (args.strictJson === true) {
    return true;
  }
  return args.settings.values.output.strictJson;
}

function formatProblemForText(error: unknown): string {
  const problem = toProblemDetails(error);
  const lines = [problem.title];
  if (problem.cause) {
    lines.push(`Cause: ${problem.cause}`);
  }
  if (problem.suggestedCommands?.length) {
    lines.push('Next commands:');
    for (const command of problem.suggestedCommands) {
      lines.push(`- ${command}`);
    }
  }
  if (lines.length === 1 && problem.detail !== problem.title) {
    lines.push(problem.detail);
  }
  return `${lines.join('\n')}\n`;
}

function stringifyWatchValue(value: unknown, fallback = '-'): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function formatWatchIncidentText(item: unknown): string {
  if (!isRecord(item)) {
    return stringifyWatchValue(item, 'Unknown incident');
  }

  const priority = stringifyWatchValue(item.priority, 'unknown').toUpperCase();
  const title = stringifyWatchValue(item.title ?? item.issue ?? item.id ?? item.uuid, 'Untitled incident');
  const device = stringifyWatchValue(item.device_name ?? item.device_id, 'unknown device');
  const space = stringifyWatchValue(item.space_tree_path_name ?? item.space_name, 'unknown space');
  return `[${priority}] ${title} | ${device} | ${space}`;
}

function formatWatchFrameText(frame: WatchFrameV1): string {
  const lines: string[] = [];
  const summary = frame.summary;

  if (frame.eventType === 'snapshot') {
    lines.push(`[snapshot] poll ${frame.pollIndex} | ${summary.total} active incidents`);
    const items = Array.isArray(frame.items) ? frame.items : [];
    if (items.length === 0) {
      lines.push('No active incidents.');
    } else {
      const preview = items.slice(0, 5);
      for (const item of preview) {
        lines.push(`- ${formatWatchIncidentText(item)}`);
      }
      if (items.length > preview.length) {
        lines.push(`... ${items.length - preview.length} more incidents`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  if (frame.eventType === 'heartbeat') {
    return `[heartbeat] poll ${frame.pollIndex} | no incident changes | ${summary.total} active incidents\n`;
  }

  if (frame.eventType === 'delta') {
    lines.push(
      `[delta] poll ${frame.pollIndex} | ${summary.total} active incidents | +${summary.added} -${summary.removed} ~${summary.updated}`
    );
    const previewEntries = [
      ...(frame.delta?.added ?? []).slice(0, 3).map((entry) => `+ ${formatWatchIncidentText(entry.current ?? entry.after ?? entry.previous)}`),
      ...(frame.delta?.updated ?? []).slice(0, 3).map((entry) => `~ ${formatWatchIncidentText(entry.after ?? entry.current ?? entry.before)}`),
      ...(frame.delta?.removed ?? []).slice(0, 3).map((entry) => `- ${formatWatchIncidentText(entry.previous ?? entry.before ?? entry.current ?? entry.id)}`)
    ];
    if (previewEntries.length === 0) {
      lines.push('No incident detail changes captured.');
    } else {
      lines.push(...previewEntries);
    }
    return `${lines.join('\n')}\n`;
  }

  if (frame.eventType === 'error') {
    const detail = frame.error?.detail ?? frame.error?.title ?? 'Watch failed.';
    return `[error] poll ${frame.pollIndex} | ${detail}\n`;
  }

  return `${JSON.stringify(frame)}\n`;
}

interface RootLauncherPayload {
  schemaVersion: 'xyte.root.launcher.v1';
  generatedAtUtc: string;
  readiness: ReadinessCheck;
  configured: boolean;
  settings: {
    tenantId?: string;
    outputMode: CliTextJsonOutputMode;
    consoleScreen: TuiScreenId;
  };
  sections: Array<{
    title: string;
    description: string;
    commands: string[];
  }>;
}

function buildRootLauncherPayload(args: {
  readiness: ReadinessCheck;
  settings: ResolvedCliSettingsState;
}): RootLauncherPayload {
  const tenantId = args.settings.values.defaults.tenant ?? args.readiness.tenantId ?? SIMPLE_SETUP_DEFAULT_TENANT;
  const configured = args.readiness.state === 'ready';
  const sections = configured
    ? [
        {
          title: 'Everyday Ops',
          description: 'Operator flows and fleet visibility.',
          commands: [
            `xyte-cli ops watch incidents --tenant ${tenantId} --once --output json --strict-json`,
            `xyte-cli ops inspect fleet --tenant ${tenantId} --output json`,
            `xyte-cli ops inspect deep-dive --tenant ${tenantId} --render markdown`
          ]
        },
        {
          title: 'Raw API',
          description: 'Direct endpoint discovery and invocation.',
          commands: [
            `xyte-cli api endpoints list --tenant ${tenantId}`,
            `xyte-cli api endpoints describe organization.devices.getDevices`,
            `xyte-cli api call organization.devices.getDevices --tenant ${tenantId} --output json`
          ]
        },
        {
          title: 'Config & Credentials',
          description: 'Inspect resolved settings, tenants, and key slots.',
          commands: [
            'xyte-cli config show --scope resolved',
            `xyte-cli config tenant use ${tenantId}`,
            `xyte-cli config key list --tenant ${tenantId} --output text`
          ]
        },
        {
          title: 'Console / Headless',
          description: 'Interactive console and machine-readable frames.',
          commands: [
            `xyte-cli ops console --screen ${args.settings.values.console.screen}`,
            `xyte-cli ops console --headless --screen dashboard --tenant ${tenantId} --output json`
          ]
        },
        {
          title: 'Examples',
          description: 'Task-first shortcuts.',
          commands: [
            `xyte-cli flow run flow.daily-deep-dive-report --tenant ${tenantId} --plan`,
            `xyte-cli util prepare --action organization.devices.claimDevice --tenant ${tenantId} --input ./claims.csv`
          ]
        }
      ]
    : [
        {
          title: 'Setup',
          description: 'First-run onboarding and readiness checks.',
          commands: [
            `xyte-cli setup run --tenant ${tenantId}`,
            `xyte-cli setup status --tenant ${tenantId}`,
            `xyte-cli config doctor --tenant ${tenantId}`
          ]
        },
        {
          title: 'Everyday Ops',
          description: 'Console entrypoints become useful after setup succeeds.',
          commands: [`xyte-cli ops console --screen setup`, `xyte-cli status --mode full --tenant ${tenantId}`]
        },
        {
          title: 'Raw API',
          description: 'Once credentials exist, raw API calls live under api.',
          commands: [`xyte-cli api endpoints list --tenant ${tenantId}`, `xyte-cli api call organization.getOrganizationInfo --tenant ${tenantId}`]
        },
        {
          title: 'Config & Credentials',
          description: 'Store tenants, key slots, and layered defaults.',
          commands: [
            'xyte-cli config show --scope resolved',
            `xyte-cli config tenant add ${tenantId}`,
            `xyte-cli config key add --tenant ${tenantId} --provider xyte-org --name primary`
          ]
        },
        {
          title: 'Console / Headless',
          description: 'Root no longer auto-opens the console.',
          commands: [`xyte-cli ops console --screen setup`, `xyte-cli ops console --headless --screen setup --output json`]
        },
        {
          title: 'Examples',
          description: 'Canonical v2 entrypoints.',
          commands: ['xyte-cli init --scope both --agents all', 'xyte-cli --output json']
        }
      ];

  return {
    schemaVersion: 'xyte.root.launcher.v1',
    generatedAtUtc: new Date().toISOString(),
    readiness: args.readiness,
    configured,
    settings: {
      tenantId: args.settings.values.defaults.tenant,
      outputMode: args.settings.values.output.mode,
      consoleScreen: args.settings.values.console.screen
    },
    sections
  };
}

function formatRootLauncherText(payload: RootLauncherPayload): string {
  const lines = [
    'xyte-cli',
    `Readiness: ${payload.readiness.state}`,
    `Tenant: ${payload.readiness.tenantId ?? 'none'}`,
    `Connectivity: ${payload.readiness.connectionState} (${payload.readiness.connectivity.message})`
  ];

  for (const section of payload.sections) {
    lines.push('');
    lines.push(section.title);
    lines.push(section.description);
    for (const command of section.commands) {
      lines.push(`- ${command}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

async function runSlotConnectivityTest(args: {
  provider: SecretProvider;
  tenantId: string;
  key: string;
  profileStore: ProfileStore;
}) {
  if (args.provider === 'xyte-org') {
    const client = createXyteClient({
      profileStore: args.profileStore,
      tenantId: args.tenantId,
      auth: { organization: args.key }
    });
    await client.organization.getOrganizationInfo({ tenantId: args.tenantId });
    return {
      strategy: 'organization.getOrganizationInfo',
      ok: true
    };
  }

  if (args.provider === 'xyte-partner') {
    const client = createXyteClient({
      profileStore: args.profileStore,
      tenantId: args.tenantId,
      auth: { partner: args.key }
    });
    await client.partner.getDevices({ tenantId: args.tenantId });
    return {
      strategy: 'partner.getDevices',
      ok: true
    };
  }

  return {
    strategy: 'local-only',
    ok: true,
    note: 'Provider key presence verified locally.'
  };
}

export function createCli(runtime: CliRuntime = {}): Command {
  const stdout = runtime.stdout ?? process.stdout;
  const stderr = runtime.stderr ?? process.stderr;
  const prompt = runtime.promptValue ?? promptValue;
  const readStdin = runtime.readStdinValue ?? readStdinValue;
  const isInteractive = runtime.isTTY ?? Boolean(process.stdin.isTTY);
  const stdoutIsTTY =
    runtime.stdoutIsTTY ??
    Boolean(('isTTY' in stdout ? (stdout as typeof process.stdout).isTTY : undefined) ?? process.stdout.isTTY);
  const profileStore = runtime.profileStore ?? new FileProfileStore();
  const runTui = runtime.runTui ?? runTuiApp;
  const cwd = runtime.cwd ?? process.cwd();
  const env = runtime.env ?? process.env;

  let secretStorePromise: Promise<SecretStore> | undefined;
  const getSecretStore = async () => {
    if (runtime.secretStore) {
      return runtime.secretStore;
    }
    if (!secretStorePromise) {
      secretStorePromise = createSecretStore();
    }
    return secretStorePromise;
  };

  const resolveSettings = async (flagOverrides: Partial<Record<SettingKey, unknown>> = {}) => {
    const activeTenantId = (await profileStore.getData()).activeTenantId;
    return resolveCliSettingsSync({
      cwd,
      env,
      activeTenantId,
      flagOverrides
    });
  };

  const withClient = async (
    tenantId?: string,
    retry?: { attempts?: number; backoffMs?: number },
    flagOverrides: Partial<Record<SettingKey, unknown>> = {}
  ) => {
    const secretStore = await getSecretStore();
    const settings = await resolveSettings(flagOverrides);
    const resolvedTenantId = tenantId ?? settings.values.defaults.tenant;
    return createXyteClient({
      profileStore,
      secretStore,
      tenantId: resolvedTenantId,
      retryAttempts: retry?.attempts ?? settings.values.http.retryAttempts,
      retryBackoffMs: retry?.backoffMs ?? settings.values.http.retryBackoffMs
    });
  };

  const resolveTenantNameFromKey = async (args: {
    tenantId: string;
    provider: SecretProvider;
    keyValue: string;
  }): Promise<string | undefined> => {
    if (args.provider !== 'xyte-org') {
      return undefined;
    }

    try {
      const secretStore = await getSecretStore();
      const client = createXyteClient({
        profileStore,
        secretStore,
        auth: { organization: args.keyValue }
      });
      const info = await client.organization.getOrganizationInfo({ tenantId: args.tenantId });
      return extractTenantNameFromOrganizationInfo(info);
    } catch {
      return undefined;
    }
  };

  const runSimpleSetup = async (args: {
    tenantId: string;
    tenantName: string;
    keyValue: string;
    setActive?: boolean;
    connectivityMode?: SetupConnectivityMode;
  }) => {
    const steps: SetupStep[] = [];
    await profileStore.upsertTenant({
      id: args.tenantId,
      name: args.tenantName
    });
    steps.push({
      key: 'tenant_upserted',
      status: 'ok',
      detail: args.tenantId
    });
    await profileStore.setActiveTenant(args.tenantId);
    steps.push({
      key: 'tenant_activated',
      status: 'ok',
      detail: args.tenantId
    });

    const secretStore = await getSecretStore();
    const slots = await profileStore.listKeySlots(args.tenantId, SIMPLE_SETUP_AUTH_PROVIDER);
    const existing = slots.find((slot) => slot.name.toLowerCase() === SIMPLE_SETUP_SLOT_NAME);

    const slot = existing
      ? await profileStore.updateKeySlot(args.tenantId, SIMPLE_SETUP_AUTH_PROVIDER, existing.slotId, {
          fingerprint: makeKeyFingerprint(args.keyValue)
        })
      : await profileStore.addKeySlot(args.tenantId, {
          provider: SIMPLE_SETUP_AUTH_PROVIDER,
          name: SIMPLE_SETUP_SLOT_NAME,
          fingerprint: makeKeyFingerprint(args.keyValue)
        });

    await secretStore.setSlotSecret(args.tenantId, SIMPLE_SETUP_AUTH_PROVIDER, slot.slotId, args.keyValue);
    steps.push({
      key: 'slot_written',
      status: 'ok',
      detail: slot.slotId
    });
    if (args.setActive !== false) {
      await profileStore.setActiveKeySlot(args.tenantId, SIMPLE_SETUP_AUTH_PROVIDER, slot.slotId);
      steps.push({
        key: 'slot_activated',
        status: 'ok',
        detail: slot.slotId
      });
    } else {
      steps.push({
        key: 'slot_activated',
        status: 'skipped',
        detail: 'setActive=false'
      });
    }

    const connectivityMode = args.connectivityMode ?? 'auto';
    const checkConnectivity = connectivityMode !== 'never';
    const client = checkConnectivity ? await withClient(args.tenantId) : undefined;
    const readiness = await evaluateReadiness({
      profileStore,
      secretStore,
      tenantId: args.tenantId,
      client,
      checkConnectivity
    });
    steps.push({
      key: 'connectivity_checked',
      status: checkConnectivity ? 'ok' : 'skipped',
      detail: checkConnectivity ? readiness.connectivity.message : 'Connectivity probe skipped by setup mode.'
    });
    steps.push({
      key: 'readiness_evaluated',
      status: 'ok',
      detail: readiness.state
    });

    return {
      tenantId: args.tenantId,
      provider: SIMPLE_SETUP_AUTH_PROVIDER,
      slot,
      readiness,
      connectivityMode,
      steps
    };
  };

  const handleRootLauncher = async (options: { output?: string } = {}) => {
    const settings = await resolveSettings();
    const tenantId = settings.values.defaults.tenant;
    const secretStore = await getSecretStore();
    const client = tenantId ? await withClient(tenantId) : undefined;
    const readiness = await evaluateReadiness({
      profileStore,
      secretStore,
      tenantId,
      client,
      checkConnectivity: true
    });
    const payload = buildRootLauncherPayload({ readiness, settings });
    const output = resolveTextJsonOutput({
      output: options.output,
      stdoutIsTTY,
      settings
    });

    if (output === 'text') {
      stdout.write(formatRootLauncherText(payload));
      return;
    }

    printJson(stdout, payload, { strictJson: resolveStrictJson({ settings }) });
  };

  const handleInit = async (options: {
    target?: string;
    scope?: string;
    agents?: string;
    force?: boolean;
    setup?: boolean;
    requireSetup?: boolean;
  }) => {
    let scope = parseSkillInstallScope(options.scope);
    let agents = parseSkillAgents(options.agents);
    if (isInteractive) {
      if (!scope) {
        scope = parseSkillInstallScope(
          await prompt({
            question: 'Install scope (project|user|both)',
            initial: 'project',
            stdout
          })
        );
      }
      if (!agents) {
        agents = parseSkillAgents(
          await prompt({
            question: 'Agents (all|claude,copilot,codex)',
            initial: 'all',
            stdout
          })
        );
      }
    }
    scope = scope ?? 'project';
    agents = agents ?? [...SKILL_AGENTS];

    const skillSource = resolveSkillSourceDir();
    const result = await installSkills({
      skillName: 'xyte-cli',
      sourceDir: skillSource,
      scope,
      agents,
      targetWorkspace: options.target,
      force: options.force === true
    });

    if (scope === 'project' || scope === 'both') {
      stdout.write(`✅ Workspace target: \`${result.workspaceRoot}\`.\n`);
    }
    if (scope === 'user' || scope === 'both') {
      stdout.write(`✅ User target: \`${result.homeRoot}\`.\n`);
    }
    stdout.write('Skill install summary:\n');
    result.outcomes.forEach((outcome) => stdout.write(`${formatInstallOutcome(outcome)}\n`));

    const failed = result.outcomes.filter((outcome) => outcome.status === 'failed');
    if (failed.length > 0) {
      throw new CliUserError({
        summary: 'Skill installation failed.',
        cause: `Failed on ${failed.length} target(s).`,
        suggestedCommands: ['Re-run with xyte-cli init --force', 'Inspect the failed targets reported above.']
      });
    }

    if (options.setup === false) {
      return;
    }

    let keyValue = await resolveKeyValue({
      envKey: env.XYTE_CLI_KEY,
      allowPrompt: isInteractive,
      prompt,
      readStdin,
      promptQuestion: 'XYTE API key',
      stdout
    });
    let tenantLabel = SIMPLE_SETUP_DEFAULT_TENANT;

    if (isInteractive) {
      tenantLabel =
        (await prompt({
          question: 'Tenant label (optional)',
          initial: tenantLabel,
          stdout
        })).trim() || SIMPLE_SETUP_DEFAULT_TENANT;
    }

    if (!keyValue) {
      if (options.requireSetup === true) {
        throw new CliUserError({
          summary: 'Missing API key for init setup.',
          cause: 'Neither XYTE_CLI_KEY nor interactive input supplied a key.',
          suggestedCommands: ['Run xyte-cli setup run --tenant <tenant-id>', 'Re-run xyte-cli init --no-setup']
        });
      }
      stdout.write('Setup skipped: no API key was provided.\n');
      stdout.write('Next steps:\n');
      stdout.write('- Run xyte-cli setup run --tenant <tenant-id>\n');
      stdout.write('- Or re-run xyte-cli init --require-setup after setting XYTE_CLI_KEY\n');
      return;
    }

    const tenantId = normalizeTenantId(tenantLabel);
    const setupResult = await runSimpleSetup({
      tenantId,
      tenantName: tenantLabel,
      keyValue,
      setActive: true,
      connectivityMode: 'auto'
    });

    if (setupResult.readiness.state !== 'ready') {
      if (options.requireSetup === true) {
        throw new CliUserError({
          summary: 'Init setup did not complete.',
          cause: setupResult.readiness.connectivity.message || 'Connectivity validation failed.',
          suggestedCommands: [`xyte-cli setup status --tenant ${tenantId}`, `xyte-cli config doctor --tenant ${tenantId}`]
        });
      }
      stdout.write(`Setup needs follow-up for tenant \`${tenantId}\`.\n`);
      stdout.write(`Next steps: xyte-cli setup status --tenant ${tenantId}\n`);
      stdout.write(`            xyte-cli config doctor --tenant ${tenantId}\n`);
      return;
    }

    stdout.write(`✅ Setup complete for tenant \`${tenantId}\`.\n`);
  };

  const handleSetupStatus = async (options: { tenant?: string; output?: string; format?: OutputFormat; field?: string }) => {
    const settings = await resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
    const secretStore = await getSecretStore();
    const tenantId = options.tenant ?? settings.values.defaults.tenant;
    const client = tenantId ? await withClient(tenantId) : undefined;
    const readiness = await evaluateReadiness({
      profileStore,
      secretStore,
      tenantId,
      client,
      checkConnectivity: true
    });

    if (options.field) {
      const fieldValue = resolveFieldValue(readiness, options.field);
      stdout.write(`${formatScalarFieldValue(fieldValue, options.field)}\n`);
      return;
    }

    if (
      resolveTextJsonOutput({
        output: options.output,
        format: options.format,
        stdoutIsTTY,
        settings
      }) === 'text'
    ) {
      stdout.write(formatReadinessText(readiness));
      return;
    }
    printJson(stdout, readiness, { strictJson: resolveStrictJson({ settings }) });
  };

  const handleSetupRun = async (options: {
    tenant?: string;
    name?: string;
    advanced?: boolean;
    provider?: string;
    slotName?: string;
    key?: string;
    keyStdin?: boolean;
    setActive?: boolean;
    connectivity?: string;
    nonInteractive?: boolean;
    output?: string;
    format?: OutputFormat;
  }) => {
    if (!options.nonInteractive && !isInteractive) {
      throw new CliUserError({
        summary: 'Interactive setup requires a TTY.',
        suggestedCommands: ['Use xyte-cli setup run --non-interactive --tenant <tenant-id> --key-stdin']
      });
    }

    const settings = await resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
    const explicitTenantName = typeof options.name === 'string' && options.name.trim().length > 0;
    const connectivityMode = parseSetupConnectivityMode(options.connectivity);
    const advanced = options.advanced === true || options.provider !== undefined;
    const output = resolveTextJsonOutput({
      output: options.output,
      format: options.format,
      stdoutIsTTY,
      settings
    });
    if (!advanced) {
      let tenantLabel =
        (options.name ?? options.tenant ?? settings.values.defaults.tenant ?? SIMPLE_SETUP_DEFAULT_TENANT).trim() ||
        SIMPLE_SETUP_DEFAULT_TENANT;
      let keyValue = await resolveKeyValue({
        key: options.key,
        keyStdin: options.keyStdin,
        envKey: env.XYTE_CLI_KEY,
        allowPrompt: !options.nonInteractive,
        prompt,
        readStdin,
        promptQuestion: 'XYTE API key',
        stdout
      });

      if (!options.nonInteractive) {
        tenantLabel =
          (await prompt({
            question: 'Tenant label (optional)',
            initial: tenantLabel,
            stdout
          })) || tenantLabel;
      }

      if (!keyValue) {
        throw new CliUserError({
          summary: 'Missing API key.',
          cause: 'Setup needs --key, --key-stdin, XYTE_CLI_KEY, or interactive input.',
          suggestedCommands: ['Use xyte-cli setup run --tenant <tenant-id>']
        });
      }

      const tenantId = normalizeTenantId(options.tenant?.trim() || tenantLabel);
      const tenantName = tenantLabel.trim() || tenantId;
      const resolvedTenantName =
        connectivityMode !== 'never' && !explicitTenantName && tenantName === tenantId
          ? await resolveTenantNameFromKey({
              tenantId,
              provider: SIMPLE_SETUP_AUTH_PROVIDER,
              keyValue
            })
          : undefined;
      const setupResult = await runSimpleSetup({
        tenantId,
        tenantName: resolvedTenantName ?? tenantName,
        keyValue,
        setActive: options.setActive !== false,
        connectivityMode
      });

      if (output === 'text') {
        stdout.write(formatReadinessText(setupResult.readiness));
        return;
      }

      printJson(stdout, setupResult, { strictJson: resolveStrictJson({ settings }) });
      return;
    }

    let tenantId = options.tenant ?? settings.values.defaults.tenant;
    let tenantName = options.name;
    let provider = options.provider ? parseProvider(options.provider) : undefined;
    let slotName = options.slotName ?? 'primary';
    let keyValue = await resolveKeyValue({
      key: options.key,
      keyStdin: options.keyStdin,
      envKey: env.XYTE_CLI_KEY,
      allowPrompt: !options.nonInteractive,
      prompt,
      readStdin,
      promptQuestion: 'API key',
      stdout
    });
    const steps: SetupStep[] = [];

    if (!options.nonInteractive) {
      tenantId = tenantId || (await prompt({ question: 'Tenant id', stdout }));
      tenantName = tenantName || (await prompt({ question: 'Tenant display name', initial: tenantId, stdout }));
      const providerAnswer = provider || parseProvider(await prompt({ question: 'Provider', initial: 'xyte-org', stdout }));
      provider = providerAnswer;
      slotName = await prompt({ question: 'Slot name', initial: slotName, stdout });
    }

    if (!tenantId) {
      throw new CliUserError({
        summary: 'Missing tenant id.',
        suggestedCommands: ['Use xyte-cli setup run --advanced --tenant <tenant-id> --provider xyte-org']
      });
    }
    if (!provider) {
      throw new CliUserError({
        summary: 'Missing provider.',
        suggestedCommands: ['Use --provider xyte-org', 'Use --provider xyte-partner']
      });
    }
    if (!keyValue) {
      throw new CliUserError({
        summary: 'Missing API key.',
        suggestedCommands: ['Use xyte-cli setup run --advanced --tenant <tenant-id> --provider xyte-org']
      });
    }

    const candidateTenantName = (tenantName?.trim() || tenantId).trim() || tenantId;
    const resolvedTenantName =
      connectivityMode !== 'never' && !explicitTenantName && candidateTenantName === tenantId
        ? await resolveTenantNameFromKey({
            tenantId,
            provider,
            keyValue
          })
        : undefined;
    tenantName = resolvedTenantName ?? candidateTenantName;

    await profileStore.upsertTenant({
      id: tenantId,
      name: tenantName
    });
    steps.push({
      key: 'tenant_upserted',
      status: 'ok',
      detail: tenantId
    });
    await profileStore.setActiveTenant(tenantId);
    steps.push({
      key: 'tenant_activated',
      status: 'ok',
      detail: tenantId
    });
    const secretStore = await getSecretStore();

    let slot;
    try {
      slot = await profileStore.addKeySlot(tenantId, {
        provider,
        name: slotName,
        fingerprint: makeKeyFingerprint(keyValue)
      });
    } catch (error) {
      const knownSlots = await profileStore.listKeySlots(tenantId, provider);
      const existing = knownSlots.find((item) => item.name.toLowerCase() === slotName.toLowerCase());
      if (!existing) {
        throw error;
      }
      slot = await profileStore.updateKeySlot(tenantId, provider, existing.slotId, {
        fingerprint: makeKeyFingerprint(keyValue)
      });
    }
    await secretStore.setSlotSecret(tenantId, provider, slot.slotId, keyValue);
    steps.push({
      key: 'slot_written',
      status: 'ok',
      detail: slot.slotId
    });

    if (options.setActive !== false) {
      await profileStore.setActiveKeySlot(tenantId, provider, slot.slotId);
      steps.push({
        key: 'slot_activated',
        status: 'ok',
        detail: slot.slotId
      });
    } else {
      steps.push({
        key: 'slot_activated',
        status: 'skipped',
        detail: 'setActive=false'
      });
    }

    const checkConnectivity = connectivityMode !== 'never';
    const client = checkConnectivity ? await withClient(tenantId) : undefined;
    const readiness = await evaluateReadiness({
      profileStore,
      secretStore,
      tenantId,
      client,
      checkConnectivity
    });
    steps.push({
      key: 'connectivity_checked',
      status: checkConnectivity ? 'ok' : 'skipped',
      detail: checkConnectivity ? readiness.connectivity.message : 'Connectivity probe skipped by setup mode.'
    });
    steps.push({
      key: 'readiness_evaluated',
      status: 'ok',
      detail: readiness.state
    });

    if (output === 'text') {
      stdout.write(formatReadinessText(readiness));
      return;
    }

    printJson(
      stdout,
      {
        tenantId,
        provider,
        slot,
        readiness,
        connectivityMode,
        steps
      },
      { strictJson: resolveStrictJson({ settings }) }
    );
  };

  const handleConfigDoctor = async (options: {
    tenant?: string;
    retryAttempts?: string;
    retryBackoffMs?: string;
    output?: string;
    format?: OutputFormat;
  }) => {
    const overrides: Partial<Record<SettingKey, unknown>> = {};
    if (options.tenant) {
      overrides['defaults.tenant'] = options.tenant;
    }
    if (options.retryAttempts) {
      overrides['http.retryAttempts'] = parsePositiveIntegerOption(options.retryAttempts, 2, 'retry-attempts');
    }
    if (options.retryBackoffMs) {
      overrides['http.retryBackoffMs'] = parsePositiveIntegerOption(options.retryBackoffMs, 250, 'retry-backoff-ms');
    }
    const settings = await resolveSettings(overrides);
    const tenantId = options.tenant ?? settings.values.defaults.tenant;
    const secretStore = await getSecretStore();
    const client = await withClient(tenantId, undefined, overrides);
    const readiness = await evaluateReadiness({
      profileStore,
      secretStore,
      tenantId,
      client,
      checkConnectivity: true
    });

    if (
      resolveTextJsonOutput({
        output: options.output,
        format: options.format,
        stdoutIsTTY,
        settings
      }) === 'text'
    ) {
      stdout.write(formatReadinessText(readiness));
      return;
    }

    printJson(
      stdout,
      {
        retryAttempts: settings.values.http.retryAttempts,
        retryBackoffMs: settings.values.http.retryBackoffMs,
        readiness
      },
      { strictJson: resolveStrictJson({ settings }) }
    );
  };

  const handleConfigShow = async (options: {
    scope?: string;
    output?: string;
    format?: OutputFormat;
  }) => {
    const scope = (options.scope ?? 'resolved').trim().toLowerCase();
    if (!['user', 'workspace', 'resolved'].includes(scope)) {
      throw new CliUserError({
        summary: 'Invalid config scope.',
        cause: `Received "${options.scope}".`,
        suggestedCommands: ['Use --scope resolved', 'Use --scope user', 'Use --scope workspace']
      });
    }
    const settings = await resolveSettings();
    const output = resolveTextJsonOutput({
      output: options.output,
      format: options.format,
      stdoutIsTTY,
      settings
    });
    const payload =
      scope === 'resolved'
        ? settings
        : {
            schemaVersion: 'xyte.settings.v1',
            scope,
            path: scope === 'user' ? settings.paths.user : settings.paths.workspace,
            values: scope === 'user' ? settings.user : settings.workspace
          };

    if (output === 'text') {
      stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }
    printJson(stdout, payload, { strictJson: resolveStrictJson({ settings }) });
  };

  const handleConfigPath = async (options: { output?: string; format?: OutputFormat }) => {
    const settings = await resolveSettings();
    const output = resolveTextJsonOutput({
      output: options.output,
      format: options.format,
      stdoutIsTTY,
      settings
    });
    const payload = {
      schemaVersion: 'xyte.settings.v1',
      configDir: settings.paths.configDir,
      user: settings.paths.user,
      workspace: settings.paths.workspace,
      secretStore: path.join(settings.paths.configDir, 'secrets.v1.json'),
      profile: path.join(settings.paths.configDir, 'profile.json')
    };

    if (output === 'text') {
      stdout.write(`configDir: ${payload.configDir}\nuser: ${payload.user}\nworkspace: ${payload.workspace}\nprofile: ${payload.profile}\nsecretStore: ${payload.secretStore}\n`);
      return;
    }
    printJson(stdout, payload, { strictJson: resolveStrictJson({ settings }) });
  };

  const handleConfigSet = async (key: string, value: string, options: { scope?: string; output?: string; format?: OutputFormat }) => {
    if (!SUPPORTED_SETTING_KEYS.includes(key as SettingKey)) {
      throw new CliUserError({
        summary: 'Unknown config key.',
        cause: `Received "${key}".`,
        suggestedCommands: [`Supported keys: ${SUPPORTED_SETTING_KEYS.join(', ')}`]
      });
    }
    const scope = (options.scope ?? 'user').trim().toLowerCase();
    if (scope !== 'user' && scope !== 'workspace') {
      throw new CliUserError({
        summary: 'Invalid config scope.',
        cause: `Received "${options.scope}".`,
        suggestedCommands: ['Use --scope user', 'Use --scope workspace']
      });
    }
    const targetScope = scope as Exclude<SettingsScope, 'resolved'>;
    const parsedValue = parseSettingValue(key as SettingKey, value);
    const result = setCliSettingSync({
      scope: targetScope,
      key: key as SettingKey,
      value: parsedValue,
      cwd,
      env
    });
    const settings = await resolveSettings();
    const output = resolveTextJsonOutput({
      output: options.output,
      format: options.format,
      stdoutIsTTY,
      settings
    });
    const payload = {
      schemaVersion: 'xyte.settings.v1',
      scope,
      path: result.path,
      key,
      value: parsedValue,
      values: result.data
    };
    if (output === 'text') {
      stdout.write(`Set ${key}=${JSON.stringify(parsedValue)} in ${result.path}\n`);
      return;
    }
    printJson(stdout, payload, { strictJson: resolveStrictJson({ settings }) });
  };

  const handleConfigUnset = async (key: string, options: { scope?: string; output?: string; format?: OutputFormat }) => {
    if (!SUPPORTED_SETTING_KEYS.includes(key as SettingKey)) {
      throw new CliUserError({
        summary: 'Unknown config key.',
        cause: `Received "${key}".`,
        suggestedCommands: [`Supported keys: ${SUPPORTED_SETTING_KEYS.join(', ')}`]
      });
    }
    const scope = (options.scope ?? 'user').trim().toLowerCase();
    if (scope !== 'user' && scope !== 'workspace') {
      throw new CliUserError({
        summary: 'Invalid config scope.',
        cause: `Received "${options.scope}".`,
        suggestedCommands: ['Use --scope user', 'Use --scope workspace']
      });
    }
    const targetScope = scope as Exclude<SettingsScope, 'resolved'>;
    const result = unsetCliSettingSync({
      scope: targetScope,
      key: key as SettingKey,
      cwd,
      env
    });
    const settings = await resolveSettings();
    const output = resolveTextJsonOutput({
      output: options.output,
      format: options.format,
      stdoutIsTTY,
      settings
    });
    const payload = {
      schemaVersion: 'xyte.settings.v1',
      scope,
      path: result.path,
      key,
      values: result.data
    };
    if (output === 'text') {
      stdout.write(`Unset ${key} in ${result.path}\n`);
      return;
    }
    printJson(stdout, payload, { strictJson: resolveStrictJson({ settings }) });
  };

  const handleApiEndpointsList = async (options: { tenant?: string; output?: string; format?: string }) => {
    const settings = await resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
    const tenantId = options.tenant ?? settings.values.defaults.tenant;
    const payload = tenantId ? await (await withClient(tenantId)).listTenantEndpoints(tenantId) : listEndpoints();
    const output = resolveTextJsonOutput({
      output: options.output,
      format: options.format,
      stdoutIsTTY,
      settings
    });
    if (output === 'text') {
      const rows = Array.isArray(payload) ? payload.map((item) => item.key) : [];
      stdout.write(rows.join('\n') + (rows.length ? '\n' : ''));
      return;
    }
    printJson(stdout, payload, { strictJson: resolveStrictJson({ settings }) });
  };

  const handleApiEndpointsDescribe = async (key: string, options: { output?: string; format?: string } = {}) => {
    const settings = await resolveSettings();
    const endpoint = getEndpoint(key);
    const output = resolveTextJsonOutput({
      output: options.output,
      format: options.format,
      stdoutIsTTY,
      settings
    });
    if (output === 'text') {
      stdout.write(`${endpoint.key}\n${endpoint.method} ${endpoint.pathTemplate}\nauth=${endpoint.authScope}\n`);
      return;
    }
    printJson(stdout, endpoint, { strictJson: resolveStrictJson({ settings }) });
  };

  const handleApiCall = async (key: string, options: Record<string, unknown>) => {
    const tenantOverride = typeof options.tenant === 'string' ? options.tenant : undefined;
    const settings = await resolveSettings(tenantOverride ? { 'defaults.tenant': tenantOverride } : {});
    const endpoint = getEndpoint(key);
    const method = endpoint.method.toUpperCase();
    const outputMode = String(options.outputMode ?? 'raw').trim().toLowerCase();
    if (!['raw', 'envelope'].includes(outputMode)) {
      throw new CliUserError({
        summary: 'Invalid API call output mode.',
        cause: `Received "${outputMode}".`,
        suggestedCommands: ['Use --output-mode raw', 'Use --output-mode envelope']
      });
    }
    const requestId = randomUUID();
    const tenantId = tenantOverride ?? settings.values.defaults.tenant;
    const path = parsePathJson(options.pathJson as string | undefined);
    const query = parseQueryJson(options.queryJson as string | undefined);
    const body = options.bodyJson ? JSON.parse(String(options.bodyJson)) : undefined;
    const strictJson = resolveStrictJson({ strictJson: options.strictJson === true, settings });
    const mutating = isMutatingMethod(method);

    try {
      const client = await withClient(tenantId);
      const result = await client.callWithMeta(key, {
        requestId,
        tenantId,
        path,
        query,
        body
      });

      if (outputMode === 'envelope') {
        const envelope = buildCallEnvelope({
          requestId,
          tenantId,
          endpointKey: key,
          method,
          guard: {
            allowWrite: mutating
          },
          request: {
            path,
            query,
            body
          },
          response: {
            status: result.status,
            durationMs: result.durationMs,
            retryCount: result.retryCount,
            data: result.data
          }
        });
        printJson(stdout, envelope, { strictJson });
        return;
      }

      const output = resolveTextJsonOutput({
        output: options.output as string | undefined,
        stdoutIsTTY,
        settings
      });
      if (output === 'text') {
        stdout.write(`${JSON.stringify(result.data, null, 2)}\n`);
        return;
      }
      printJson(stdout, result.data, { strictJson });
    } catch (error) {
      if (outputMode !== 'envelope') {
        throw error;
      }

      const envelope = buildCallEnvelope({
        requestId,
        tenantId,
        endpointKey: key,
        method,
        guard: {
          allowWrite: mutating
        },
        request: {
          path,
          query,
          body
        },
        error: toProblemDetails(error, `/api/call/${key}`)
      });
      printJson(stdout, envelope, { strictJson });
      process.exitCode = 1;
    }
  };

  const handleOpsWatchIncidents = async (options: {
    tenant?: string;
    profile?: string;
    queryJson?: string;
    intervalMs?: string;
    maxPolls?: string;
    once?: boolean;
    output?: string;
    out?: string;
    strictJson?: boolean;
  }) => {
    const overrides: Partial<Record<SettingKey, unknown>> = {};
    if (options.tenant) {
      overrides['defaults.tenant'] = options.tenant;
    }
    if (options.profile) {
      overrides['watch.profile'] = parseWatchProfile(options.profile);
    }
    if (options.intervalMs) {
      overrides['watch.intervalMs'] = parseWatchIntervalMs(options.intervalMs);
    }
    if (options.maxPolls) {
      overrides['watch.maxPolls'] = parseWatchMaxPolls(options.maxPolls);
    }
    const settings = await resolveSettings(overrides);
    const tenantId = options.tenant ?? settings.values.defaults.tenant;
    const query = parseQueryJson(options.queryJson);
    const output = resolveTextJsonOutput({
      output: options.output,
      stdoutIsTTY,
      settings
    });
    const strictJson = resolveStrictJson({ strictJson: options.strictJson, settings });
    const outPath = resolveOutPath(options.out);
    if (outPath) {
      ensureParentDir(outPath);
      writeFileSync(outPath, '', 'utf8');
    }
    const client = await withClient(tenantId, undefined, overrides);
    await runWatch({
      client,
      tenantId,
      profile: (overrides['watch.profile'] as 'incidents-active' | undefined) ?? settings.values.watch.profile,
      query,
      intervalMs: (overrides['watch.intervalMs'] as number | undefined) ?? settings.values.watch.intervalMs,
      once: options.once === true,
      maxPolls:
        options.maxPolls !== undefined
          ? (overrides['watch.maxPolls'] as number | undefined)
          : settings.values.watch.maxPolls,
      onFrame: (frame) => {
        if (output === 'text') {
          appendRenderedOutput(stdout, formatWatchFrameText(frame), outPath);
          return;
        }
        appendRenderedOutput(stdout, renderJsonOutput(frame, { strictJson, compact: true }), outPath);
      }
    });
  };

  const handleOpsInspectFleet = async (options: {
    tenant?: string;
    providerScope?: string;
    render?: string;
    format?: string;
    output?: string;
    out?: string;
    strictJson?: boolean;
  }) => {
    const overrides: Partial<Record<SettingKey, unknown>> = {};
    if (options.tenant) {
      overrides['defaults.tenant'] = options.tenant;
    }
    if (options.providerScope) {
      overrides['ops.providerScope'] = parseInspectProviderScope(options.providerScope);
    }
    const settings = await resolveSettings(overrides);
    const tenantId = options.tenant ?? settings.values.defaults.tenant;
    if (!tenantId) {
      throw new CliUserError({
        summary: 'Missing tenant for ops inspect fleet.',
        suggestedCommands: ['Use --tenant <tenant-id>', 'Set defaults.tenant via xyte-cli config set defaults.tenant <tenant-id>']
      });
    }
    const render = (options.render ?? options.format ?? 'json').trim().toLowerCase();
    if (!['json', 'ascii'].includes(render)) {
      throw new CliUserError({
        summary: 'Invalid inspect fleet render mode.',
        cause: `Received "${render}".`,
        suggestedCommands: ['Use --render json', 'Use --render ascii']
      });
    }
    const providerScope =
      (overrides['ops.providerScope'] as InspectProviderScope | undefined) ?? settings.values.ops.providerScope;
    const client = await withClient(tenantId, undefined, overrides);
    const tenantProfile = await profileStore.getTenant(tenantId);
    const snapshot = await collectFleetSnapshot(client, tenantId, tenantProfile?.name, providerScope);
    const result = buildFleetInspect(snapshot);
    const outPath = resolveOutPath(options.out);

    if (render === 'ascii') {
      writeRenderedOutput(stdout, `${formatFleetInspectAscii(result)}\n`, outPath);
      return;
    }

    const output = resolveTextJsonOutput({
      output: options.output,
      stdoutIsTTY,
      settings
    });
    if (output === 'text') {
      writeRenderedOutput(stdout, `${formatFleetInspectAscii(result)}\n`, outPath);
      return;
    }
    writeRenderedOutput(
      stdout,
      renderJsonOutput(result, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) }),
      outPath
    );
  };

  const handleOpsInspectDeepDive = async (options: {
    tenant?: string;
    providerScope?: string;
    window?: string;
    render?: string;
    format?: string;
    output?: string;
    out?: string;
    strictJson?: boolean;
  }) => {
    const overrides: Partial<Record<SettingKey, unknown>> = {};
    if (options.tenant) {
      overrides['defaults.tenant'] = options.tenant;
    }
    if (options.providerScope) {
      overrides['ops.providerScope'] = parseInspectProviderScope(options.providerScope);
    }
    const settings = await resolveSettings(overrides);
    const tenantId = options.tenant ?? settings.values.defaults.tenant;
    if (!tenantId) {
      throw new CliUserError({
        summary: 'Missing tenant for ops inspect deep-dive.',
        suggestedCommands: ['Use --tenant <tenant-id>', 'Set defaults.tenant via xyte-cli config set defaults.tenant <tenant-id>']
      });
    }
    const render = (options.render ?? options.format ?? 'json').trim().toLowerCase();
    if (!['json', 'ascii', 'markdown'].includes(render)) {
      throw new CliUserError({
        summary: 'Invalid deep-dive render mode.',
        cause: `Received "${render}".`,
        suggestedCommands: ['Use --render json', 'Use --render ascii', 'Use --render markdown']
      });
    }
    const providerScope =
      (overrides['ops.providerScope'] as InspectProviderScope | undefined) ?? settings.values.ops.providerScope;
    const windowHours = Number.parseInt(options.window ?? '24', 10);
    const client = await withClient(tenantId, undefined, overrides);
    const tenantProfile = await profileStore.getTenant(tenantId);
    const snapshot = await collectFleetSnapshot(client, tenantId, tenantProfile?.name, providerScope);
    const result = buildDeepDive(snapshot, Number.isFinite(windowHours) ? windowHours : 24);
    const outPath = resolveOutPath(options.out);

    if (render === 'ascii') {
      writeRenderedOutput(stdout, `${formatDeepDiveAscii(result)}\n`, outPath);
      return;
    }
    if (render === 'markdown') {
      writeRenderedOutput(stdout, `${formatDeepDiveMarkdown(result, false)}\n`, outPath);
      return;
    }

    const output = resolveTextJsonOutput({
      output: options.output,
      stdoutIsTTY,
      settings
    });
    if (output === 'text') {
      writeRenderedOutput(stdout, `${formatDeepDiveMarkdown(result, false)}\n`, outPath);
      return;
    }
    writeRenderedOutput(
      stdout,
      renderJsonOutput(result, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) }),
      outPath
    );
  };

  const handleOpsReportGenerate = async (options: {
    tenant?: string;
    input: string;
    out: string;
    render?: 'markdown' | 'pdf';
    format?: 'markdown' | 'pdf';
    includeSensitive?: boolean;
    strictJson?: boolean;
  }) => {
    const overrides: Partial<Record<SettingKey, unknown>> = {};
    if (options.tenant) {
      overrides['defaults.tenant'] = options.tenant;
    }
    if (options.includeSensitive === true) {
      overrides['report.includeSensitive'] = true;
    }
    const settings = await resolveSettings(overrides);
    const tenantId = options.tenant ?? settings.values.defaults.tenant;
    if (!tenantId) {
      throw new CliUserError({
        summary: 'Missing tenant for ops report generate.',
        suggestedCommands: ['Use --tenant <tenant-id>', 'Set defaults.tenant via xyte-cli config set defaults.tenant <tenant-id>']
      });
    }
    const inputPath = path.resolve(options.input);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown;
    } catch {
      throw new CliUserError({
        summary: 'Input JSON is invalid.',
        cause: `Failed to parse ${inputPath}.`,
        suggestedCommands: ['Generate fresh input with xyte-cli ops inspect deep-dive --output json']
      });
    }

    const render = (options.render ?? options.format ?? 'pdf').trim().toLowerCase();
    if (!['markdown', 'pdf'].includes(render)) {
      throw new CliUserError({
        summary: 'Invalid report render mode.',
        cause: `Received "${render}".`,
        suggestedCommands: ['Use --render pdf', 'Use --render markdown']
      });
    }

    let deepDive = parseDeepDiveForReport(raw, tenantId);
    if (!deepDive.tenantName) {
      const tenantProfile = await profileStore.getTenant(tenantId);
      if (tenantProfile?.name) {
        deepDive = {
          ...deepDive,
          tenantName: tenantProfile.name
        };
      }
    }

    const generated = await generateFleetReport({
      deepDive,
      format: render as 'markdown' | 'pdf',
      outPath: options.out,
      includeSensitive: options.includeSensitive === true || settings.values.report.includeSensitive
    });
    printJson(stdout, generated, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
  };

  const handleOpsConsole = async (options: {
    headless?: boolean;
    screen?: string;
    format?: string;
    output?: string;
    once?: boolean;
    follow?: boolean;
    intervalMs?: string;
    tenant?: string;
    motion?: boolean;
    debug?: boolean;
    debugLog?: string;
  }) => {
    const overrides: Partial<Record<SettingKey, unknown>> = {};
    if (options.tenant) {
      overrides['defaults.tenant'] = options.tenant;
    }
    if (options.screen) {
      overrides['console.screen'] = options.screen as TuiScreenId;
    }
    if (options.motion === false) {
      overrides['console.motion'] = false;
    }
    if (options.follow === true) {
      overrides['console.follow'] = true;
    }
    if (options.intervalMs) {
      overrides['console.intervalMs'] = parsePositiveIntegerOption(options.intervalMs, 2000, 'interval-ms');
    }
    if (options.debugLog) {
      overrides['console.debugLogPath'] = options.debugLog;
    }
    const settings = await resolveSettings(overrides);
    const secretStore = await getSecretStore();
    const client = createXyteClient({
      profileStore,
      secretStore,
      tenantId: options.tenant ?? settings.values.defaults.tenant,
      retryAttempts: settings.values.http.retryAttempts,
      retryBackoffMs: settings.values.http.retryBackoffMs
    });
    const allowedScreens: TuiScreenId[] = ['setup', 'config', 'dashboard', 'spaces', 'devices', 'incidents', 'tickets'];
    const screen = (options.screen ?? settings.values.console.screen ?? 'dashboard') as TuiScreenId;
    if (!allowedScreens.includes(screen)) {
      throw new CliUserError({
        summary: 'Invalid console screen.',
        cause: `Received "${options.screen}".`,
        suggestedCommands: [`Use one of: ${allowedScreens.join(', ')}`]
      });
    }
    const requestedOutput = parseCliTextJsonOutputMode(options.output ?? options.format ?? (options.headless ? 'json' : undefined));
    if (Boolean(options.headless) && requestedOutput && requestedOutput !== 'json') {
      throw new CliUserError({
        summary: 'Headless mode is JSON-only.',
        suggestedCommands: ['Use xyte-cli ops console --headless --output json']
      });
    }
    const follow = options.once ? false : options.follow ?? settings.values.console.follow;
    const intervalMs =
      options.intervalMs !== undefined
        ? parsePositiveIntegerOption(options.intervalMs, settings.values.console.intervalMs, 'interval-ms')
        : settings.values.console.intervalMs;
    const motionEnabled = options.motion === false ? false : settings.values.console.motion;

    await runTui({
      client,
      profileStore,
      secretStore,
      initialScreen: screen,
      headless: Boolean(options.headless),
      format: (options.headless ? 'json' : requestedOutput === 'text' ? 'text' : 'json') as OutputFormat,
      motionEnabled,
      follow,
      intervalMs,
      tenantId: options.tenant ?? settings.values.defaults.tenant,
      output: stdout,
      debug: options.debug,
      debugLogPath: options.debugLog ?? settings.values.console.debugLogPath
    });
  };

  const handleUtilPrepare = async (options: {
    input: string;
    action: string;
    tenant?: string;
    outputDir?: string;
    primaryFormat?: string;
    force?: boolean;
    strictJson?: boolean;
  }) => {
    const settings = await resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
    const result = buildUtilityPrepare({
      inputPath: options.input,
      actionKey: options.action,
      outputDir: options.outputDir,
      tenantId: options.tenant ?? settings.values.defaults.tenant,
      primaryFormat: parseUtilityPreparePrimaryFormat(options.primaryFormat),
      force: options.force === true
    });
    printJson(stdout, result, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
  };

  const handleUtilListActions = async (options: {
    output?: string;
    format?: string;
    entity?: string;
    includeGeneric?: boolean;
    strictJson?: boolean;
  }) => {
    const settings = await resolveSettings();
    const output = resolveTextJsonOutput({
      output: options.output,
      format: options.format,
      stdoutIsTTY,
      settings
    });
    const actions = listUtilityPrepareActions({
      entity: options.entity,
      includeGeneric: options.includeGeneric !== false
    });
    if (output === 'json') {
      printJson(stdout, actions, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
      return;
    }
    if (!actions.length) {
      stdout.write('No utility actions found.\n');
      return;
    }
    for (const action of actions) {
      stdout.write(`${action.actionKey} | entity=${action.entity} | mode=${action.mode} | execution=${action.executionSupport}\n`);
    }
  };

  const handleUtilImportTree = async (options: {
    tenant?: string;
    input: string;
    inputFormat?: string;
    pathField?: string;
    spaceTypeField?: string;
    configField?: string;
    apply?: boolean;
    continueOnError?: boolean;
    report?: string;
    strictJson?: boolean;
  }) => {
    const settings = await resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
    const tenantId = options.tenant ?? settings.values.defaults.tenant;
    if (!tenantId) {
      throw new CliUserError({
        summary: 'Missing tenant for util import-tree.',
        suggestedCommands: ['Use --tenant <tenant-id>', 'Set defaults.tenant via xyte-cli config set defaults.tenant <tenant-id>']
      });
    }
    const client = await withClient(tenantId);
    const result = await runSpaceImportTree({
      client,
      tenantId,
      inputPath: options.input,
      inputFormat: parseUtilityInputFormat(options.inputFormat),
      apply: options.apply === true,
      continueOnError: options.continueOnError === true,
      reportPath: options.report,
      pathField: options.pathField,
      spaceTypeField: options.spaceTypeField,
      configField: options.configField
    });
    printJson(stdout, result, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
    if (result.totals.failed > 0) {
      process.exitCode = 1;
    }
  };

  const program = new Command();
  let actionLogger: CliActionLogger | undefined;
  let actionLogVerbose = false;
  let activeAction: ActiveCliAction | undefined;
  const actionStartByCommand = new WeakMap<Command, number>();

  const getOrCreateActionLogger = (command: Command): CliActionLogger => {
    if (actionLogger) {
      return actionLogger;
    }

    const options = command.optsWithGlobals() as CliGlobalOptions;
    const settings = resolveCliSettingsSync({ cwd, env });
    const envEnabled = parseBooleanEnvFlag(process.env.XYTE_LOG_ACTIONS);
    const envMirrorToStderr = parseBooleanEnvFlag(process.env.XYTE_LOG_ACTIONS_STDERR);
    const envVerbose = parseBooleanEnvFlag(process.env.XYTE_LOG_ACTIONS_VERBOSE);
    const configuredPath = options.logActionsPath ?? settings.values.logs.path ?? process.env.XYTE_LOG_ACTIONS_PATH;
    const enabled = options.logActions === true || settings.values.logs.enabled || envEnabled || Boolean(configuredPath);
    const maxFileBytes = settings.values.logs.maxFileBytes;
    const maxFiles = settings.values.logs.maxFiles;
    actionLogVerbose = options.logActionsVerbose === true || settings.values.logs.verbose || envVerbose;

    actionLogger = createCliActionLogger({
      enabled,
      path: configuredPath,
      mirrorToStderr: options.logActions === true || envMirrorToStderr,
      stderr,
      argv: actionLogVerbose ? argvForCommand(command) : undefined,
      maxFileBytes,
      maxFiles
    });
    return actionLogger;
  };

  program.name('xyte-cli').description('Agent-first Xyte CLI and console').version(getCliVersion());
  program.showSuggestionAfterError(true);
  program.option('--error-format <format>', 'text|json', 'text');
  program.option('--output <mode>', 'auto|json|text', 'auto');
  program.option('--log-actions', 'Log each CLI action (start/complete/error) to NDJSON');
  program.option('--log-actions-path <path>', 'Write action logs to this NDJSON file');
  program.option('--log-actions-verbose', 'Include command args/options payloads in action logs');
  program.addHelpText(
    'after',
    [
      '',
      'Setup:',
      '  xyte-cli init --scope both --agents all',
      '  xyte-cli setup run --non-interactive --tenant <tenant-id> --key-stdin',
      '',
      'Everyday Ops:',
      '  xyte-cli ops watch incidents --tenant <tenant-id> --once --output json --strict-json',
      '  xyte-cli ops inspect fleet --tenant <tenant-id> --output json',
      '',
      'Raw API:',
      '  xyte-cli api endpoints list --tenant <tenant-id>',
      '  xyte-cli api call organization.devices.getDevices --tenant <tenant-id> --output json',
      '',
      'Config & Credentials:',
      '  xyte-cli config show --scope resolved',
      '  xyte-cli config key list --tenant <tenant-id>',
      '',
      'Console / Headless:',
      '  xyte-cli ops console --screen dashboard',
      '  xyte-cli ops console --headless --screen dashboard --output json',
      '',
      'Examples:',
      '  xyte-cli flow run flow.daily-deep-dive-report --tenant <tenant-id> --plan',
      '  xyte-cli util prepare --action organization.devices.claimDevice --tenant <tenant-id> --input ./claims.csv'
    ].join('\n')
  );

  program
    .command('init')
    .description('Bootstrap workspace skills and optionally run first-time setup')
    .option('--target <path>', 'Workspace directory override')
    .option('--scope <scope>', 'project|user|both')
    .option('--agents <agents>', 'all|claude|copilot|codex[,..]')
    .option('--force', 'Overwrite existing skill install')
    .option('--no-setup', 'Skip guided setup after installing skills')
    .option('--require-setup', 'Fail if guided setup cannot complete')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  xyte-cli init --scope both --agents all',
        '  xyte-cli init --target ./workspace --no-setup'
      ].join('\n')
    )
    .action(handleInit);

  program.action(async (_args: unknown, command: Command) => {
    const options = command.optsWithGlobals() as { output?: string };
    await handleRootLauncher({ output: options.output });
  });

  const doctor = program.command('doctor').description('Runtime diagnostics');

  doctor
    .command('install')
    .description('Check global xyte-cli command wiring')
    .option('--format <format>', 'json|text', 'json')
    .action(async (options: { format?: OutputFormat }, command: Command) => {
      const report = runInstallDoctor();
      const settings = await resolveSettings();
      if (
        resolveTextJsonOutput({
          output: getExplicitGlobalOutput(command),
          format: options.format,
          stdoutIsTTY,
          settings
        }) === 'text'
      ) {
        stdout.write(
          [
            `Status: ${report.status}`,
            `Command on PATH: ${report.commandOnPath}`,
            `Command path: ${report.commandPath ?? 'not found'}`,
            `Command real path: ${report.commandRealPath ?? 'n/a'}`,
            `Expected path: ${report.expectedPath}`,
            `Expected real path: ${report.expectedRealPath}`,
            `Same target: ${report.sameTarget}`,
            '',
            'Suggestions:',
            ...report.suggestions.map((item) => `- ${item}`)
          ].join('\n') + '\n'
        );
        return;
      }
      printJson(stdout, report, { strictJson: resolveStrictJson({ settings }) });
    });

  program
    .command('status')
    .description('Fast readiness status for operators and agents')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--mode <mode>', 'fast|full', 'fast')
    .option('--format <format>', 'json|text', 'json')
    .addHelpText(
      'after',
      [
        '',
        'Examples:',
        '  xyte-cli status',
        '  xyte-cli status --mode full --tenant <tenant-id>',
        '  xyte-cli status --output json'
      ].join('\n')
    )
    .action(async (options: { tenant?: string; mode?: string; format?: OutputFormat }, command: Command) => {
      const globals = command.optsWithGlobals() as { output?: string };
      const settings = await resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
      const mode = parseStatusMode(options.mode);
      const checkConnectivity = mode === 'full';
      const tenantId = options.tenant ?? settings.values.defaults.tenant;
      const secretStore = await getSecretStore();
      const client = checkConnectivity ? await withClient(tenantId) : undefined;
      const readiness = await evaluateReadiness({
        profileStore,
        secretStore,
        tenantId,
        client,
        checkConnectivity
      });
      const payload = buildStatusContract({
        mode,
        checkConnectivity,
        readiness
      });

      if (
        resolveTextJsonOutput({
          output: globals.output,
          format: options.format,
          stdoutIsTTY,
          settings
        }) === 'text'
      ) {
        stdout.write(`Status mode: ${payload.mode}\n`);
        stdout.write(`Generated: ${payload.generatedAtUtc}\n`);
        stdout.write(formatReadinessText(readiness));
        return;
      }

      printJson(stdout, payload, { strictJson: resolveStrictJson({ settings }) });
    });

  program
    .command('upgrade')
    .description('Update xyte-cli and refresh user-scope agent skills')
    .option('--check', 'Check current and latest version without upgrading')
    .option('--yes', 'Skip confirmation prompt')
    .option('--format <format>', 'json|text', 'json')
    .action(async (options: { check?: boolean; yes?: boolean; format?: OutputFormat }, command: Command) => {
      const settings = await resolveSettings();
      const output = resolveTextJsonOutput({
        output: getExplicitGlobalOutput(command),
        format: options.format,
        stdoutIsTTY,
        settings
      });
      const latestVersionOverride = process.env.XYTE_CLI_UPGRADE_TARGET_VERSION?.trim() || undefined;
      const installSpec = process.env.XYTE_CLI_UPGRADE_SPEC?.trim() || undefined;
      const check = await checkForUpgrade(
        { packageName: '@xyteai/cli', latestVersionOverride },
        runtime.upgradeDependencies
      );
      if (options.check) {
        if (output === 'text') {
          stdout.write(`Package: ${check.packageName}\n`);
          stdout.write(`Current: ${check.currentVersion}\n`);
          stdout.write(`Latest: ${check.latestVersion}\n`);
          stdout.write(`Up to date: ${check.upToDate}\n`);
          if (check.recommendedCommand) {
            stdout.write(`Recommended: ${check.recommendedCommand}\n`);
          }
          return;
        }
        printJson(stdout, check, { strictJson: resolveStrictJson({ settings }) });
        return;
      }

      if (!options.yes) {
        if (!isInteractive) {
          throw new Error('Upgrade requires confirmation. Re-run with --yes or use --check.');
        }
        const answer = (
          await prompt({
            question: 'Proceed with global CLI update and user-scope skills refresh? (y/N)',
            initial: 'N',
            stdout
          })
        )
          .trim()
          .toLowerCase();
        if (!['y', 'yes'].includes(answer)) {
          if (output === 'text') {
            stdout.write('Upgrade canceled.\n');
          } else {
            printJson(stdout, check, { strictJson: resolveStrictJson({ settings }) });
          }
          return;
        }
      }

      const result = await applyUpgrade(
        {
          packageName: check.packageName,
          skillSourceDir: resolveSkillSourceDir(),
          installSpec,
          latestVersionOverride
        },
        runtime.upgradeDependencies
      );

      if (output === 'text') {
        stdout.write(`Package: ${result.packageName}\n`);
        stdout.write(`Current: ${result.currentVersion}\n`);
        stdout.write(`Latest: ${result.latestVersion}\n`);
        stdout.write(`Updated: ${result.updated}\n`);
        stdout.write(`Verified version: ${result.verify.detectedVersion}\n`);
        stdout.write('Skill refresh summary:\n');
        result.skills.outcomes.forEach((outcome) => stdout.write(`${formatInstallOutcome(outcome)}\n`));
        if (result.warnings.length > 0) {
          stdout.write('Warnings:\n');
          result.warnings.forEach((warning) => stdout.write(`- ${warning}\n`));
        }
        return;
      }

      printJson(stdout, result, { strictJson: resolveStrictJson({ settings }) });
    });

  const api = program.command('api').description('Raw endpoint catalog and invocation');
  api.addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  xyte-cli api endpoints list --tenant <tenant-id>',
      '  xyte-cli api endpoints describe organization.devices.getDevices',
      '  xyte-cli api call organization.devices.getDevices --tenant <tenant-id> --output json'
    ].join('\n')
  );
  const apiEndpoints = api.command('endpoints').description('List and describe endpoint metadata');

  apiEndpoints
    .command('list')
    .option('--tenant <tenantId>', 'Filter endpoints available for tenant credentials')
    .option('--format <format>', 'json|text')
    .action(async function (options: { tenant?: string; format?: string }) {
      await handleApiEndpointsList({
        ...options,
        output: (this.optsWithGlobals() as CliGlobalOptions).output
      });
    });

  apiEndpoints
    .command('describe')
    .argument('<key>', 'Endpoint key')
    .option('--format <format>', 'json|text')
    .action(async function (key: string, options: { format?: string }) {
      await handleApiEndpointsDescribe(key, {
        ...options,
        output: (this.optsWithGlobals() as CliGlobalOptions).output
      });
    });

  api
    .command('call')
    .argument('<key>', 'Endpoint key')
    .description('Call endpoint by key')
    .option('--tenant <tenantId>', 'Tenant id')
    .option('--path-json <json>', 'Path params JSON object')
    .option('--query-json <json>', 'Query params JSON object')
    .option('--body-json <json>', 'Body JSON object')
    .option('--output-mode <mode>', 'raw|envelope', 'raw')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (key: string, options: Record<string, unknown>) {
      await handleApiCall(key, {
        ...options,
        output: (this.optsWithGlobals() as CliGlobalOptions).output
      });
    });

  const ops = program.command('ops').description('Operator-focused console, watch, inspect, and report workflows');
  ops.addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  xyte-cli ops watch incidents --tenant <tenant-id> --once',
      '  xyte-cli ops watch incidents --tenant <tenant-id> --once --output json --strict-json',
      '  xyte-cli ops inspect fleet --tenant <tenant-id> --output json',
      '  xyte-cli ops console --screen dashboard'
    ].join('\n')
  );
  const opsWatch = ops.command('watch').description('Watch operator-facing streams');
  opsWatch
    .command('incidents')
    .description('Watch active incidents as terminal text or JSON frames')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--profile <profile>', 'Watch profile override')
    .option('--query-json <json>', 'Query params JSON object (merged over defaults)')
    .option('--interval-ms <ms>', 'Polling interval in ms (minimum 1000)')
    .option('--max-polls <n>', 'Stop after N polls (maximum 3600)')
    .option('--once', 'Run one poll and exit')
    .option('--out <path>', 'Write the rendered output to a UTF-8 file')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: Record<string, unknown>) {
      await handleOpsWatchIncidents({
        ...options,
        output: (this.optsWithGlobals() as CliGlobalOptions).output
      });
    });

  const opsInspect = ops.command('inspect').description('Deterministic fleet insights');
  opsInspect
    .command('fleet')
    .description('Build a fleet summary snapshot')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--provider-scope <scope>', 'organization|partner|auto')
    .option('--render <render>', 'json|ascii', 'json')
    .option('--out <path>', 'Write the rendered output to a UTF-8 file')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: {
      tenant?: string;
      providerScope?: string;
      render?: string;
      out?: string;
      strictJson?: boolean;
    }) {
      await handleOpsInspectFleet({
        ...options,
        output: (this.optsWithGlobals() as CliGlobalOptions).output
      });
    });

  opsInspect
    .command('deep-dive')
    .description('Build deep-dive operational analytics')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--provider-scope <scope>', 'organization|partner|auto')
    .option('--window <hours>', 'Window in hours', '24')
    .option('--render <render>', 'json|ascii|markdown', 'json')
    .option('--out <path>', 'Write the rendered output to a UTF-8 file')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: {
      tenant?: string;
      providerScope?: string;
      window?: string;
      render?: string;
      out?: string;
      strictJson?: boolean;
    }) {
      await handleOpsInspectDeepDive({
        ...options,
        output: (this.optsWithGlobals() as CliGlobalOptions).output
      });
    });

  const opsReport = ops.command('report').description('Generate reports from inspect outputs');
  opsReport
    .command('generate')
    .description('Generate report from deep-dive JSON input')
    .requiredOption('--input <path>', 'Path to deep-dive JSON input')
    .requiredOption('--out <path>', 'Output path')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--render <render>', 'markdown|pdf', 'pdf')
    .option('--include-sensitive', 'Include full ticket/device IDs in report')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: {
      tenant?: string;
      input: string;
      out: string;
      render?: 'markdown' | 'pdf';
      includeSensitive?: boolean;
      strictJson?: boolean;
    }) {
      await handleOpsReportGenerate(options);
    });

  ops
    .command('console')
    .description('Launch the interactive console or JSON-only headless mode')
    .option('--headless', 'Run headless visual mode for agents')
    .option('--screen <screen>', 'setup|config|dashboard|spaces|devices|incidents|tickets')
    .option('--once', 'Render one frame and exit (default behavior)')
    .option('--follow', 'Continuously stream frames')
    .option('--interval-ms <ms>', 'Polling interval for --follow')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--no-motion', 'Disable motion and animation effects')
    .option('--debug', 'Enable TUI debug logging')
    .option('--debug-log <path>', 'Write TUI debug logs to this file')
    .action(async function (options: {
      headless?: boolean;
      screen?: string;
      once?: boolean;
      follow?: boolean;
      intervalMs?: string;
      tenant?: string;
      motion?: boolean;
      debug?: boolean;
      debugLog?: string;
    }) {
      await handleOpsConsole({
        ...options,
        output: getExplicitGlobalOutput(this)
      });
    });

  const util = program.command('util').description('Utility preprocessing and import workflows');
  util.addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  xyte-cli util list-actions --output text',
      '  xyte-cli util prepare --action organization.devices.claimDevice --tenant <tenant-id> --input ./claims.csv',
      '  xyte-cli util import-tree --tenant <tenant-id> --input ./space-import.csv'
    ].join('\n')
  );
  util
    .command('prepare')
    .description('Build preprocessing contract and scaffold canonical files for one action')
    .requiredOption('--input <path>', 'Input source path')
    .requiredOption('--action <actionKey>', 'Action key (endpoint key or space.import-tree)')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--output-dir <path>', 'Directory for scaffolded files')
    .option('--primary-format <format>', 'csv|jsonl')
    .option('--force', 'Overwrite scaffold files if they already exist')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(handleUtilPrepare);

  util
    .command('list-actions')
    .description('List utility prepare action keys')
    .option('--entity <entity>', 'Filter by entity')
    .option('--include-generic', 'Include generic profiles', true)
    .option('--no-include-generic', 'Exclude generic profiles')
    .option('--format <format>', 'json|text')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: { entity?: string; includeGeneric?: boolean; format?: string; strictJson?: boolean }) {
      await handleUtilListActions({
        ...options,
        output: (this.optsWithGlobals() as CliGlobalOptions).output
      });
    });

  util
    .command('import-tree')
    .description('Create or find spaces from file-defined paths')
    .requiredOption('--input <path>', 'Input path (CSV/JSON/JSONL)')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--input-format <format>', 'auto|csv|json|jsonl', 'auto')
    .option('--path-field <name>', 'Input column/field for full path', 'path')
    .option('--space-type-field <name>', 'Input column/field for space type', 'space_type')
    .option('--config-field <name>', 'Input column/field for config object', 'config')
    .option('--apply', 'Apply changes (default is dry-run)')
    .option('--continue-on-error', 'Continue processing rows after failures')
    .option('--report <path>', 'Write NDJSON row report file')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(handleUtilImportTree);

  const flow = program.command('flow').description('Deterministic flow orchestration');

  flow
    .command('list')
    .description('List built-in and custom flow IDs')
    .action(async () => {
      const builtIn = listBuiltInFlowDefinitions().map((item) => ({
        type: 'built-in' as const,
        id: item.id,
        title: item.title,
        intent: item.intent,
        writeCapable: item.writeCapable
      }));
      const customDefs = await listFlowDefinitions();
      const custom = customDefs.map((item) => ({
        type: 'custom' as const,
        id: item.id,
        title: item.title,
        description: item.description,
        basedOn: item.basedOn,
        defaults: item.defaults,
        path: item.path,
        updatedAtUtc: item.updatedAtUtc
      }));

      printJson(stdout, {
        schemaVersion: 'xyte.flow.catalog.v1',
        generatedAtUtc: new Date().toISOString(),
        builtIn,
        custom
      });
    });

  flow
    .command('create')
    .description('Create a custom shareable flow definition (aliasing a built-in flow)')
    .argument('<flowId>', 'Custom flow id (flow.<name>)')
    .requiredOption('--based-on <flowId>', 'Built-in flow id to alias')
    .option('--title <title>', 'Flow title')
    .option('--description <description>', 'Flow description')
    .option('--context-json <path>', 'JSON object of default context values')
    .option('--var <key=value>', 'Default context override (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
    .option('--force', 'Overwrite if flow already exists')
    .action(
      async (
        flowId: string,
        options: {
          basedOn: string;
          title?: string;
          description?: string;
          contextJson?: string;
          var?: string[];
          force?: boolean;
        }
      ) => {
        if (!hasBuiltInFlowDefinition(options.basedOn)) {
          throw new Error(`Custom flows must be based on a built-in flow id. Unknown: ${options.basedOn}`);
        }
        const defaults = {
          ...parseFlowContextJson(options.contextJson),
          ...parseFlowVarOptions(options.var)
        };
        const saved = await saveFlowDefinition({
          flowId,
          basedOn: options.basedOn,
          title: options.title,
          description: options.description,
          defaults,
          overwrite: options.force === true
        });
        printJson(stdout, saved);
      }
    );

  flow
    .command('edit')
    .description('Edit a custom flow definition')
    .argument('<flowId>', 'Custom flow id')
    .option('--based-on <flowId>', 'Built-in flow id to alias')
    .option('--title <title>', 'Flow title')
    .option('--description <description>', 'Flow description')
    .option('--context-json <path>', 'JSON object of default context values')
    .option('--var <key=value>', 'Default context override (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
    .option('--replace-defaults', 'Replace defaults instead of merging')
    .action(
      async (
        flowId: string,
        options: {
          basedOn?: string;
          title?: string;
          description?: string;
          contextJson?: string;
          var?: string[];
          replaceDefaults?: boolean;
        }
      ) => {
        if (options.basedOn && !hasBuiltInFlowDefinition(options.basedOn)) {
          throw new Error(`Custom flows must be based on a built-in flow id. Unknown: ${options.basedOn}`);
        }
        const mergedDefaults = {
          ...parseFlowContextJson(options.contextJson),
          ...parseFlowVarOptions(options.var)
        };
        const defaultsProvided = Object.keys(mergedDefaults).length > 0 || options.replaceDefaults === true;
        const updated = await updateFlowDefinition({
          flowId,
          basedOn: options.basedOn,
          title: options.title,
          description: options.description,
          ...(defaultsProvided ? { defaults: mergedDefaults } : {}),
          replaceDefaults: options.replaceDefaults === true
        });
        printJson(stdout, updated);
      }
    );

  flow
    .command('share')
    .description('Export a custom flow definition for sharing')
    .argument('<flowId>', 'Custom flow id')
    .requiredOption('--out <path>', 'Export path')
    .action(async (flowId: string, options: { out: string }) => {
      printJson(stdout, await exportFlowDefinition(flowId, options.out));
    });

  flow
    .command('import')
    .description('Import a shared custom flow definition')
    .requiredOption('--file <path>', 'Path to a shared flow definition JSON')
    .option('--force', 'Overwrite existing flow definition')
    .action(async (options: { file: string; force?: boolean }) => {
      const imported = await importFlowDefinition(options.file, options.force === true);
      if (!hasBuiltInFlowDefinition(imported.basedOn)) {
        throw new Error(`Imported flow ${imported.id} references unknown built-in base flow: ${imported.basedOn}`);
      }
      printJson(stdout, imported);
    });

  flow
    .command('run')
    .description('Run a deterministic flow by id')
    .argument('<flowId>', 'Flow id (built-in or custom alias)')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .option('--plan', 'Dry mode (default)')
    .option('--apply', 'Advance the next human gate')
    .option('--resume <runRef>', 'Resume from a previous run id or bundle path')
    .option('--out-dir <path>', 'Flow run bundle root directory', './tmp/flow-runs')
    .option('--inspect-provider-scope <scope>', 'organization|partner|auto')
    .option('--context-json <path>', 'JSON object file for flow context')
    .option('--var <key=value>', 'Flow context override (repeatable)', (value: string, previous: string[]) => [...previous, value], [])
    .option('--once', 'Shorten long watch loops')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(
      async (
        flowId: string,
        options: {
          tenant: string;
          plan?: boolean;
          apply?: boolean;
          resume?: string;
          outDir?: string;
          inspectProviderScope?: string;
          contextJson?: string;
          var?: string[];
          once?: boolean;
          strictJson?: boolean;
        }
      ) => {
        const mode = parseFlowMode(options);
        const inspectProviderScope = options.inspectProviderScope
          ? parseInspectProviderScope(options.inspectProviderScope)
          : undefined;
        const runtimeContext = {
          ...parseFlowContextJson(options.contextJson),
          ...parseFlowVarOptions(options.var)
        };

        let resolvedFlowId = flowId;
        let defaults: Record<string, string> = {};
        if (!hasBuiltInFlowDefinition(flowId)) {
          const custom = await getFlowDefinition(flowId);
          if (!custom) {
            throw new Error(`Unknown flow id: ${flowId}`);
          }
          if (!hasBuiltInFlowDefinition(custom.basedOn)) {
            throw new Error(`Custom flow ${flowId} references unknown built-in base flow: ${custom.basedOn}`);
          }
          resolvedFlowId = custom.basedOn;
          defaults = custom.defaults;
        }

        const definition = getBuiltInFlowDefinition(resolvedFlowId);
        const summary = await runDeterministicFlow({
          flowId,
          resolvedFlowId,
          definition,
          tenantId: options.tenant,
          mode,
          outDir: options.outDir ?? './tmp/flow-runs',
          inspectProviderScope,
          resume: options.resume,
          context: {
            ...defaults,
            ...runtimeContext
          },
          once: options.once === true,
          strictJson: options.strictJson === true,
          profileStore,
          secretStore: await getSecretStore(),
          client: await withClient(options.tenant)
        });

        printJson(stdout, summary, { strictJson: options.strictJson });
        if (summary.outcome === 'failed' && summary.classifications.bug > 0) {
          process.exitCode = 1;
        }
      }
    );

  const setup = program.command('setup').description('Run setup and readiness checks');

  setup
    .command('status')
    .description('Show setup/readiness status')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--field <name>', 'Print a single scalar field (for example tenantId)')
    .option('--format <format>', 'json|text', 'json')
    .action(async (options: { tenant?: string; field?: string; format?: OutputFormat }, command: Command) => {
      const globals = command.optsWithGlobals() as { output?: string };
      await handleSetupStatus({ tenant: options.tenant, field: options.field, format: options.format, output: globals.output });
    });

  setup
    .command('run')
    .description('Run setup flow (simple first-run by default, advanced with --advanced)')
    .option('--tenant <tenantId>', 'Tenant id')
    .option('--name <name>', 'Tenant display name')
    .option('--advanced', 'Use advanced provider/slot prompts')
    .option('--provider <provider>', 'Primary provider for key setup')
    .option('--slot-name <name>', 'Key slot name', 'primary')
    .option('--key <value>', 'API key value')
    .option('--key-stdin', 'Read API key value from stdin')
    .option('--set-active', 'Set slot active (default true in setup flow)')
    .option('--connectivity <mode>', 'auto|always|never', 'auto')
    .option('--non-interactive', 'Disable prompts and require needed options')
    .option('--format <format>', 'json|text', 'json')
    .action(
      async (
        options: {
          tenant?: string;
          name?: string;
          advanced?: boolean;
          provider?: string;
          slotName?: string;
          key?: string;
          keyStdin?: boolean;
          setActive?: boolean;
          connectivity?: string;
          nonInteractive?: boolean;
          format?: OutputFormat;
        },
        command: Command
      ) => {
        const globals = command.optsWithGlobals() as { output?: string };
        await handleSetupRun({ ...options, output: globals.output });
      }
    );

  const config = program.command('config').description('Configuration and diagnostics');

  config
    .command('doctor')
    .description('Run connectivity and readiness diagnostics')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--retry-attempts <n>', 'Retry attempts for HTTP transport', '2')
    .option('--retry-backoff-ms <n>', 'Retry backoff (ms) for HTTP transport', '250')
    .option('--format <format>', 'json|text', 'json')
    .action(async (options: { tenant?: string; retryAttempts?: string; retryBackoffMs?: string; format?: OutputFormat }, command: Command) => {
      const globals = command.optsWithGlobals() as { output?: string };
      await handleConfigDoctor({
        tenant: options.tenant,
        retryAttempts: options.retryAttempts,
        retryBackoffMs: options.retryBackoffMs,
        format: options.format,
        output: globals.output
      });
    });

  config
    .command('show')
    .description('Show user, workspace, or resolved settings')
    .option('--scope <scope>', 'user|workspace|resolved', 'resolved')
    .option('--format <format>', 'json|text')
    .action(async (options: { scope?: string; format?: OutputFormat }, command: Command) => {
      const globals = command.optsWithGlobals() as { output?: string };
      await handleConfigShow({ scope: options.scope, format: options.format, output: globals.output });
    });

  config
    .command('path')
    .description('Show settings, profile, and secret-store paths')
    .option('--format <format>', 'json|text')
    .action(async (options: { format?: OutputFormat }, command: Command) => {
      const globals = command.optsWithGlobals() as { output?: string };
      await handleConfigPath({ format: options.format, output: globals.output });
    });

  config
    .command('set')
    .description('Set a layered config value')
    .argument('<key>', 'Config key')
    .argument('<value>', 'Config value')
    .option('--scope <scope>', 'user|workspace', 'user')
    .option('--format <format>', 'json|text')
    .action(async (key: string, value: string, options: { scope?: string; format?: OutputFormat }, command: Command) => {
      const globals = command.optsWithGlobals() as { output?: string };
      await handleConfigSet(key, value, { scope: options.scope, format: options.format, output: globals.output });
    });

  config
    .command('unset')
    .description('Unset a layered config value')
    .argument('<key>', 'Config key')
    .option('--scope <scope>', 'user|workspace', 'user')
    .option('--format <format>', 'json|text')
    .action(async (key: string, options: { scope?: string; format?: OutputFormat }, command: Command) => {
      const globals = command.optsWithGlobals() as { output?: string };
      await handleConfigUnset(key, { scope: options.scope, format: options.format, output: globals.output });
    });

  const configTenant = config.command('tenant').description('Manage tenant profiles');
  configTenant
    .command('add')
    .argument('<tenantId>', 'Tenant id')
    .option('--name <name>', 'Display name')
    .option('--hub-url <url>', 'Hub API base URL')
    .option('--entry-url <url>', 'Entry API base URL')
    .action(async (tenantId: string, options: Record<string, string | undefined>) => {
      const tenantProfile = await profileStore.upsertTenant({
        id: tenantId,
        name: options.name,
        hubBaseUrl: options.hubUrl,
        entryBaseUrl: options.entryUrl
      });
      printJson(stdout, tenantProfile);
    });

  configTenant
    .command('list')
    .action(async () => {
      const data = await profileStore.getData();
      printJson(stdout, {
        activeTenantId: data.activeTenantId,
        tenants: data.tenants
      });
    });

  configTenant
    .command('use')
    .argument('<tenantId>', 'Tenant id to set active')
    .action(async (tenantId: string) => {
      await profileStore.setActiveTenant(tenantId);
      stdout.write(`Active tenant set to ${tenantId}\n`);
    });

  configTenant
    .command('remove')
    .argument('<tenantId>', 'Tenant id')
    .action(async (tenantId: string) => {
      await profileStore.removeTenant(tenantId);
      stdout.write(`Removed tenant ${tenantId}\n`);
    });

  const configKey = config.command('key').description('Manage named key slots');
  configKey
    .command('add')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .requiredOption('--provider <provider>', SUPPORTED_SECRET_PROVIDERS.join('|'))
    .requiredOption('--name <name>', 'Slot display name')
    .option('--slot-id <slotId>', 'Optional explicit slot id')
    .option('--key <value>', 'API key value')
    .option('--key-stdin', 'Read API key value from stdin')
    .option('--set-active', 'Set as active slot for provider')
    .action(async (options: { tenant: string; provider: string; name: string; slotId?: string; key?: string; keyStdin?: boolean; setActive?: boolean }) => {
      const provider = parseProvider(options.provider);
      const value = await resolveKeyValue({
        key: options.key,
        keyStdin: options.keyStdin,
        envKey: env.XYTE_CLI_KEY,
        prompt,
        readStdin,
        promptQuestion: 'API key',
        stdout
      });
      if (!value) {
        throw new CliUserError({
          summary: 'Missing key value.',
          cause: 'Use --key, --key-stdin, or XYTE_CLI_KEY.',
          suggestedCommands: ['Use xyte-cli config key add --tenant <tenant-id> --provider xyte-org --name primary']
        });
      }
      await profileStore.upsertTenant({ id: options.tenant });
      const secretStore = await getSecretStore();
      const slot = await profileStore.addKeySlot(options.tenant, {
        provider,
        name: options.name,
        slotId: options.slotId,
        fingerprint: makeKeyFingerprint(value)
      });
      await secretStore.setSlotSecret(options.tenant, provider, slot.slotId, value);
      if (options.setActive) {
        await profileStore.setActiveKeySlot(options.tenant, provider, slot.slotId);
      }
      printJson(stdout, {
        tenantId: options.tenant,
        provider,
        slot
      });
    });

  configKey
    .command('list')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .option('--provider <provider>', 'Optional provider filter')
    .option('--format <format>', 'json|text', 'json')
    .action(async (options: { tenant: string; provider?: string; format?: OutputFormat }, command: Command) => {
      const globals = command.optsWithGlobals() as { output?: string };
      const settings = await resolveSettings({ 'defaults.tenant': options.tenant });
      const secretStore = await getSecretStore();
      const provider = options.provider ? parseProvider(options.provider) : undefined;
      const slots = await collectSlotViews({
        profileStore,
        secretStore,
        tenantId: options.tenant,
        provider
      });
      if (
        resolveTextJsonOutput({
          output: globals.output,
          format: options.format,
          stdoutIsTTY,
          settings
        }) === 'text'
      ) {
        stdout.write(formatSlotListText(slots));
        return;
      }
      printJson(stdout, { tenantId: options.tenant, slots }, { strictJson: resolveStrictJson({ settings }) });
    });

  configKey
    .command('use')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .requiredOption('--provider <provider>', 'Provider')
    .requiredOption('--slot <slotRef>', 'Slot id or name')
    .action(async (options: { tenant: string; provider: string; slot: string }) => {
      const provider = parseProvider(options.provider);
      const slot = await profileStore.setActiveKeySlot(options.tenant, provider, options.slot);
      printJson(stdout, {
        tenantId: options.tenant,
        provider,
        activeSlot: slot
      });
    });

  configKey
    .command('rename')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .requiredOption('--provider <provider>', 'Provider')
    .requiredOption('--slot <slotRef>', 'Slot id or name')
    .requiredOption('--name <name>', 'New slot name')
    .action(async (options: { tenant: string; provider: string; slot: string; name: string }) => {
      const provider = parseProvider(options.provider);
      const updated = await profileStore.updateKeySlot(options.tenant, provider, options.slot, {
        name: options.name
      });
      printJson(stdout, {
        tenantId: options.tenant,
        provider,
        slot: updated
      });
    });

  configKey
    .command('update')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .requiredOption('--provider <provider>', 'Provider')
    .requiredOption('--slot <slotRef>', 'Slot id or name')
    .option('--key <value>', 'API key value')
    .option('--key-stdin', 'Read API key value from stdin')
    .action(async (options: { tenant: string; provider: string; slot: string; key?: string; keyStdin?: boolean }) => {
      const provider = parseProvider(options.provider);
      const slot = await resolveSlotByRef(profileStore, options.tenant, provider, options.slot);
      const value = await resolveKeyValue({
        key: options.key,
        keyStdin: options.keyStdin,
        envKey: env.XYTE_CLI_KEY,
        prompt,
        readStdin,
        promptQuestion: 'API key',
        stdout
      });
      if (!value) {
        throw new CliUserError({
          summary: 'Missing key value.',
          cause: 'Use --key, --key-stdin, or XYTE_CLI_KEY.',
          suggestedCommands: ['Use xyte-cli config key update --tenant <tenant-id> --provider xyte-org --slot <slot-id>']
        });
      }
      const secretStore = await getSecretStore();
      await secretStore.setSlotSecret(options.tenant, provider, slot.slotId, value);
      const updated = await profileStore.updateKeySlot(options.tenant, provider, slot.slotId, {
        fingerprint: makeKeyFingerprint(value)
      });
      printJson(stdout, {
        tenantId: options.tenant,
        provider,
        slot: updated
      });
    });

  configKey
    .command('remove')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .requiredOption('--provider <provider>', 'Provider')
    .requiredOption('--slot <slotRef>', 'Slot id or name')
    .option('--confirm', 'Confirm removal')
    .action(async (options: { tenant: string; provider: string; slot: string; confirm?: boolean }) => {
      if (!options.confirm) {
        throw new CliUserError({
          summary: 'Key slot removal is destructive.',
          suggestedCommands: ['Re-run with --confirm']
        });
      }
      const provider = parseProvider(options.provider);
      const slot = await resolveSlotByRef(profileStore, options.tenant, provider, options.slot);
      const secretStore = await getSecretStore();
      await secretStore.clearSlotSecret(options.tenant, provider, slot.slotId);
      await profileStore.removeKeySlot(options.tenant, provider, slot.slotId);
      printJson(stdout, {
        tenantId: options.tenant,
        provider,
        removedSlotId: slot.slotId
      });
    });

  configKey
    .command('test')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .requiredOption('--provider <provider>', 'Provider')
    .requiredOption('--slot <slotRef>', 'Slot id or name')
    .action(async (options: { tenant: string; provider: string; slot: string }) => {
      const provider = parseProvider(options.provider);
      const slot = await resolveSlotByRef(profileStore, options.tenant, provider, options.slot);
      const secretStore = await getSecretStore();
      const secret = await secretStore.getSlotSecret(options.tenant, provider, slot.slotId);
      if (!secret) {
        throw new CliUserError({
          summary: 'No secret found for selected key slot.',
          cause: `Slot "${slot.slotId}" has no stored secret.`,
          suggestedCommands: [`xyte-cli config key update --tenant ${options.tenant} --provider ${provider} --slot ${slot.slotId}`]
        });
      }
      const probe = await runSlotConnectivityTest({
        provider,
        tenantId: options.tenant,
        key: secret,
        profileStore
      });
      const validatedAt = new Date().toISOString();
      const updated = await profileStore.updateKeySlot(options.tenant, provider, slot.slotId, {
        lastValidatedAt: validatedAt
      });
      printJson(stdout, {
        tenantId: options.tenant,
        provider,
        slot: updated,
        probe
      });
    });

  const logs = program.command('logs').description('Inspect persisted CLI action logs');

  logs
    .command('list')
    .description('List action log entries')
    .option('--path <path>', 'Action log file override')
    .option('--limit <n>', 'Max number of entries', '100')
    .option('--event <event>', 'Filter by event name')
    .option('--command <text>', 'Filter by command path substring')
    .option('--format <format>', 'text|json', 'text')
    .action(
      async (options: {
        path?: string;
        limit?: string;
        event?: string;
        command?: string;
        format?: string;
      }, command: Command) => {
        const settings = await resolveSettings();
        const limit = parsePositiveIntegerOption(options.limit, 100, 'limit');
        const result = readCliActionLog({
          path: options.path,
          limit,
          event: options.event,
          command: options.command
        });

        if (
          resolveTextJsonOutput({
            output: getExplicitGlobalOutput(command),
            format: options.format,
            stdoutIsTTY,
            settings
          }) === 'json'
        ) {
          printJson(stdout, {
            schemaVersion: 'xyte.cli.action-log.v1',
            path: result.path,
            count: result.entries.length,
            parseErrors: result.parseErrors,
            entries: result.entries
          }, { strictJson: resolveStrictJson({ settings }) });
          return;
        }

        if (!result.entries.length) {
          stdout.write(`No action log entries found at ${result.path}\n`);
          return;
        }

        for (const entry of result.entries) {
          stdout.write(`${formatActionLogText(entry)}\n`);
        }
        if (result.parseErrors > 0) {
          stdout.write(`Ignored ${result.parseErrors} malformed log line(s).\n`);
        }
      }
    );

  logs
    .command('stats')
    .description('Show action log storage stats')
    .option('--path <path>', 'Action log file override')
    .option('--format <format>', 'text|json', 'text')
    .action(async (options: { path?: string; format?: string }, command: Command) => {
      const settings = await resolveSettings();
      const path = resolveCliActionLogPath(options.path);
      const files = listCliActionLogFiles(path);
      const totalBytes = files.reduce((sum, item) => sum + item.sizeBytes, 0);

      if (
        resolveTextJsonOutput({
          output: getExplicitGlobalOutput(command),
          format: options.format,
          stdoutIsTTY,
          settings
        }) === 'json'
      ) {
        printJson(stdout, {
          schemaVersion: 'xyte.cli.action-log.stats.v1',
          path,
          fileCount: files.length,
          totalBytes,
          files: files.map((item) => ({
            path: item.path,
            kind: item.kind,
            index: item.index,
            sizeBytes: item.sizeBytes,
            modifiedAtUtc: item.modifiedAtUtc
          }))
        }, { strictJson: resolveStrictJson({ settings }) });
        return;
      }

      stdout.write(`Path: ${path}\n`);
      stdout.write(`Files: ${files.length}\n`);
      stdout.write(`Total size: ${formatBytes(totalBytes)} (${totalBytes} bytes)\n`);
      if (!files.length) {
        return;
      }
      for (const item of files) {
        const label = item.kind === 'active' ? 'active' : `rotated.${item.index}`;
        stdout.write(`- ${label} | ${formatBytes(item.sizeBytes)} | ${item.modifiedAtUtc} | ${item.path}\n`);
      }
    });

  logs
    .command('gc')
    .description('Prune rotated action log files by count/age retention')
    .option('--path <path>', 'Action log file override')
    .option('--max-files <n>', 'Maximum total files to retain (active + rotated)')
    .option('--max-age-days <days>', 'Remove rotated files older than this many days')
    .option('--dry-run', 'Preview cleanup without deleting files')
    .option('--format <format>', 'text|json', 'text')
    .action(
      async (options: {
        path?: string;
        maxFiles?: string;
        maxAgeDays?: string;
        dryRun?: boolean;
        format?: string;
      }, command: Command) => {
        const settings = await resolveSettings();
        const maxFilesDefault = parsePositiveIntegerEnv(process.env.XYTE_LOG_ACTIONS_MAX_FILES, 5);
        const maxFiles = parsePositiveIntegerOption(options.maxFiles, maxFilesDefault, 'max-files');
        const maxAgeDays = parsePositiveNumberOption(options.maxAgeDays, undefined, 'max-age-days');
        const maxAgeMs = maxAgeDays === undefined ? undefined : Math.round(maxAgeDays * 24 * 60 * 60 * 1000);

        const before = listCliActionLogFiles(options.path);
        const beforeMap = new Map(before.map((item) => [item.path, item]));
        const result = gcCliActionLogFiles({
          path: options.path,
          maxFiles,
          maxAgeMs,
          dryRun: options.dryRun === true
        });
        const removedBytes = result.removed.reduce((sum, item) => sum + (beforeMap.get(item)?.sizeBytes ?? 0), 0);

        if (
          resolveTextJsonOutput({
            output: getExplicitGlobalOutput(command),
            format: options.format,
            stdoutIsTTY,
            settings
          }) === 'json'
        ) {
          printJson(stdout, {
            schemaVersion: 'xyte.cli.action-log.gc.v1',
            path: result.path,
            dryRun: options.dryRun === true,
            maxFiles,
            maxAgeDays,
            removedCount: result.removed.length,
            removedBytes,
            removed: result.removed,
            kept: result.kept
          }, { strictJson: resolveStrictJson({ settings }) });
          return;
        }

        stdout.write(`Path: ${result.path}\n`);
        stdout.write(`Mode: ${options.dryRun === true ? 'dry-run' : 'apply'}\n`);
        stdout.write(`Removed files: ${result.removed.length}\n`);
        stdout.write(`Freed: ${formatBytes(removedBytes)} (${removedBytes} bytes)\n`);
        if (result.removed.length) {
          for (const item of result.removed) {
            stdout.write(`- removed ${item}\n`);
          }
        }
      }
    );

  logs
    .command('view')
    .description('Interactive arrow-key action log viewer')
    .option('--path <path>', 'Action log file override')
    .option('--limit <n>', 'Max number of entries', '250')
    .option('--event <event>', 'Filter by event name')
    .option('--command <text>', 'Filter by command path substring')
    .action(async (options: { path?: string; limit?: string; event?: string; command?: string }) => {
      if (!isInteractive) {
        throw new Error('Interactive log viewer requires a TTY. Use `xyte-cli logs list` in non-interactive mode.');
      }

      const limit = parsePositiveIntegerOption(options.limit, 250, 'limit');
      const result = readCliActionLog({
        path: options.path,
        limit,
        event: options.event,
        command: options.command
      });

      if (!result.entries.length) {
        stdout.write(`No action log entries found at ${result.path}\n`);
        return;
      }

      await runActionLogViewer({
        entries: result.entries,
        title: `xyte-cli logs | ${result.path}`
      });
    });

  program.hook('preAction', (_thisCommand, actionCommand) => {
    const logger = getOrCreateActionLogger(actionCommand);
    if (!logger.enabled) {
      return;
    }

    const commandPath = commandPathFor(actionCommand);
    const startedAt = Date.now();
    actionStartByCommand.set(actionCommand, startedAt);
    activeAction = {
      commandPath,
      startedAt
    };
    if (actionLogVerbose) {
      logger.log('command.start', {
        commandPath,
        argv: sanitizeArgvForLog(argvForCommand(actionCommand)),
        args: actionCommand.args,
        options: actionCommand.optsWithGlobals()
      });
      return;
    }

    logger.log('command.start', {
      commandPath
    });
  });

  program.hook('postAction', (_thisCommand, actionCommand) => {
    const logger = getOrCreateActionLogger(actionCommand);
    if (!logger.enabled) {
      return;
    }

    const commandPath = commandPathFor(actionCommand);
    const startedAt = actionStartByCommand.get(actionCommand) ?? Date.now();
    const durationMs = Date.now() - startedAt;

    actionStartByCommand.delete(actionCommand);
    if (activeAction?.commandPath === commandPath) {
      activeAction = undefined;
    }

    logger.log('command.complete', {
      commandPath,
      durationMs,
      exitCode: process.exitCode ?? 0
    });
  });

  (program as CliProgramWithActionLogState)[CLI_ACTION_LOG_STATE] = () => ({
    logger: actionLogger,
    activeAction,
    verbose: actionLogVerbose
  });

  program.exitOverride((error) => {
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
      return;
    }
    throw error;
  });

  program.configureOutput({
    writeErr: (text: string) => {
      stderr.write(text);
    }
  });

  return program;
}

export async function runCli(argv = process.argv, runtime: CliRuntime = {}): Promise<void> {
  const program = createCli(runtime);
  const stateReader = (program as CliProgramWithActionLogState)[CLI_ACTION_LOG_STATE];

  try {
    await program.parseAsync(argv);
  } catch (error) {
    const state = stateReader?.();
    if (state?.logger?.enabled) {
      const activeAction = state.activeAction;
      const verbose = state.verbose === true;
      const baseErrorPayload: Record<string, unknown> = {
        commandPath: activeAction?.commandPath ?? inferCommandPathFromArgv(argv),
        durationMs: activeAction ? Date.now() - activeAction.startedAt : undefined
      };

      if (verbose) {
        // inferCommandPathFromArgv expects full process-style argv, but logged argv should exclude runtime/executable tokens.
        baseErrorPayload.argv = sanitizeArgvForLog(argv.slice(2));
        baseErrorPayload.error = toProblemDetails(error);
      } else {
        baseErrorPayload.error = error instanceof Error ? error.message : String(error);
      }

      state.logger.log(
        'command.error',
        baseErrorPayload,
        'error'
      );
    }
    throw error;
  } finally {
    stateReader?.().logger?.close();
  }
}
