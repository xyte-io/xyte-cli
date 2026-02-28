import { createInterface } from 'node:readline/promises';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter } from 'node:path';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
import { evaluateReadiness, type ReadinessCheck } from '../config/readiness';
import { createSecretStore, type SecretStore } from '../secure/secret-store';
import { makeKeyFingerprint, matchesSlotRef } from '../secure/key-slots';
import { FileProfileStore, type ProfileStore } from '../secure/profile-store';
import type { SecretProvider } from '../types/profile';
import { SUPPORTED_SECRET_PROVIDERS, isSecretProvider } from '../types/profile';
import { parseJsonObject } from '../utils/json';
import { writeJsonLine } from '../utils/json-output';
import type { UtilityInputFormat } from '../utils/input-parser';
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

type OutputStream = Pick<typeof process.stdout, 'write'>;
type ErrorStream = Pick<typeof process.stderr, 'write'>;
type OutputFormat = 'json' | 'text';
type PromptValueFn = (args: { question: string; initial?: string; stdout: OutputStream }) => Promise<string>;
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

export interface CliRuntime {
  profileStore?: ProfileStore;
  secretStore?: SecretStore;
  stdout?: OutputStream;
  stderr?: ErrorStream;
  runTui?: typeof runTuiApp;
  promptValue?: PromptValueFn;
  isTTY?: boolean;
  upgradeDependencies?: UpgradeDependencies;
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

const SIMPLE_SETUP_PROVIDER: SecretProvider = 'xyte-org';
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

function printJson(stream: OutputStream, value: unknown, options: { strictJson?: boolean; compact?: boolean } = {}) {
  writeJsonLine(stream, value, { strictJson: options.strictJson, compact: options.compact });
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
  const raw = JSON.parse(readFileSync(resolvedPath, 'utf8')) as unknown;
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

function requiresWriteGuard(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function requiresDestructiveGuard(method: string): boolean {
  return method.toUpperCase() === 'DELETE';
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

function resolveCommandFromPath(command: string, envPath = process.env.PATH ?? ''): string | undefined {
  const pathEntries = envPath.split(delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
          .map((ext) => ext.toLowerCase())
      : [''];

  for (const entry of pathEntries) {
    for (const ext of extensions) {
      const candidate = process.platform === 'win32' ? path.join(entry, `${command}${ext}`) : path.join(entry, command);
      if (!existsSync(candidate)) {
        continue;
      }
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        continue;
      }
      return candidate;
    }
  }

  return undefined;
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

async function promptValue(args: { question: string; initial?: string; stdout: OutputStream }): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout
  });
  try {
    const suffix = args.initial ? ` [${args.initial}]` : '';
    const answer = (await rl.question(`${args.question}${suffix}: `)).trim();
    return answer || args.initial || '';
  } finally {
    rl.close();
  }
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

function requireKeyValue(value: string | undefined): string {
  const resolved = value ?? process.env.XYTE_CLI_KEY;
  if (!resolved) {
    throw new Error('Missing key value. Use --key or set XYTE_CLI_KEY environment variable.');
  }
  return resolved;
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
  const isInteractive = runtime.isTTY ?? Boolean(process.stdin.isTTY);
  const profileStore = runtime.profileStore ?? new FileProfileStore();
  const runTui = runtime.runTui ?? runTuiApp;

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

  const withClient = async (tenantId?: string, retry?: { attempts?: number; backoffMs?: number }) => {
    const secretStore = await getSecretStore();
    return createXyteClient({
      profileStore,
      secretStore,
      tenantId,
      retryAttempts: retry?.attempts,
      retryBackoffMs: retry?.backoffMs
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
    const slots = await profileStore.listKeySlots(args.tenantId, SIMPLE_SETUP_PROVIDER);
    const existing = slots.find((slot) => slot.name.toLowerCase() === SIMPLE_SETUP_SLOT_NAME);

    const slot = existing
      ? await profileStore.updateKeySlot(args.tenantId, SIMPLE_SETUP_PROVIDER, existing.slotId, {
          fingerprint: makeKeyFingerprint(args.keyValue)
        })
      : await profileStore.addKeySlot(args.tenantId, {
          provider: SIMPLE_SETUP_PROVIDER,
          name: SIMPLE_SETUP_SLOT_NAME,
          fingerprint: makeKeyFingerprint(args.keyValue)
        });

    await secretStore.setSlotSecret(args.tenantId, SIMPLE_SETUP_PROVIDER, slot.slotId, args.keyValue);
    steps.push({
      key: 'slot_written',
      status: 'ok',
      detail: slot.slotId
    });
    if (args.setActive !== false) {
      await profileStore.setActiveKeySlot(args.tenantId, SIMPLE_SETUP_PROVIDER, slot.slotId);
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
      provider: SIMPLE_SETUP_PROVIDER,
      slot,
      readiness,
      connectivityMode,
      steps
    };
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
    const envEnabled = parseBooleanEnvFlag(process.env.XYTE_LOG_ACTIONS);
    const envMirrorToStderr = parseBooleanEnvFlag(process.env.XYTE_LOG_ACTIONS_STDERR);
    const envVerbose = parseBooleanEnvFlag(process.env.XYTE_LOG_ACTIONS_VERBOSE);
    const configuredPath = options.logActionsPath ?? process.env.XYTE_LOG_ACTIONS_PATH;
    const enabled = options.logActions === true || envEnabled || Boolean(configuredPath);
    const maxFileBytes = parsePositiveIntegerEnv(process.env.XYTE_LOG_ACTIONS_MAX_FILE_BYTES, 10 * 1024 * 1024);
    const maxFiles = parsePositiveIntegerEnv(process.env.XYTE_LOG_ACTIONS_MAX_FILES, 5);
    actionLogVerbose = options.logActionsVerbose === true || envVerbose;

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

  program.name('xyte-cli').description('Xyte CLI + TUI').version(getCliVersion());
  program.option('--error-format <format>', 'text|json', 'text');
  program.option('--log-actions', 'Log each CLI action (start/complete/error) to NDJSON');
  program.option('--log-actions-path <path>', 'Write action logs to this NDJSON file');
  program.option('--log-actions-verbose', 'Include command args/options payloads in action logs');

  program
    .command('install')
    .description('Initialize workspace')
    .option('--skills', 'install local agent skills')
    .option('--target <path>', 'Workspace directory override')
    .option('--scope <scope>', 'project|user|both')
    .option('--agents <agents>', 'all|claude|copilot|codex[,..]')
    .option('--force', 'Overwrite existing skill install')
    .option('--no-setup', 'Skip guided setup after installing skills')
    .action(
      async (options: {
        skills?: boolean;
        target?: string;
        scope?: string;
        agents?: string;
        force?: boolean;
        setup?: boolean;
      }) => {
        if (!options.skills) {
          throw new Error('Use "xyte-cli install --skills" to install agent skills.');
        }

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
          throw new Error(`Skill installation failed for ${failed.length} target(s).`);
        }

        if (options.setup === false) {
          return;
        }

        let keyValue = process.env.XYTE_CLI_KEY?.trim();
        let tenantLabel = SIMPLE_SETUP_DEFAULT_TENANT;

        if (isInteractive) {
          keyValue = keyValue || (await prompt({ question: 'XYTE API key', stdout })).trim();
          tenantLabel =
            (await prompt({
              question: 'Tenant label (optional)',
              initial: tenantLabel,
              stdout
            })).trim() || SIMPLE_SETUP_DEFAULT_TENANT;
        }

        if (!keyValue) {
          throw new Error('Missing API key. Set XYTE_CLI_KEY or re-run with --no-setup.');
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
          throw new Error(
            `Setup did not complete: ${setupResult.readiness.connectivity.message || 'connectivity validation failed'}`
          );
        }

        stdout.write(`✅ Setup complete for tenant \`${tenantId}\`.\n`);
      }
    );

  program.action(async () => {
    const secretStore = await getSecretStore();
    const readinessClient = await withClient(undefined);
    const readiness = await evaluateReadiness({
      profileStore,
      secretStore,
      client: readinessClient,
      checkConnectivity: true
    });

    if (readiness.state !== 'ready') {
      if (!isInteractive) {
        throw new Error('Setup required. Run: xyte-cli setup run --non-interactive --tenant default --key "$XYTE_CLI_KEY".');
      }

      const apiKey = await prompt({ question: 'XYTE API key', stdout });
      if (!apiKey.trim()) {
        throw new Error('API key is required to complete first-run setup.');
      }

      const tenantLabelInput = await prompt({
        question: 'Tenant label (optional)',
        initial: SIMPLE_SETUP_DEFAULT_TENANT,
        stdout
      });
      const tenantLabel = tenantLabelInput.trim() || SIMPLE_SETUP_DEFAULT_TENANT;
      const tenantId = normalizeTenantId(tenantLabel);

      const setupResult = await runSimpleSetup({
        tenantId,
        tenantName: tenantLabel,
        keyValue: apiKey.trim(),
        setActive: true,
        connectivityMode: 'auto'
      });

      if (setupResult.readiness.state !== 'ready') {
        throw new Error(
          `Setup did not complete: ${setupResult.readiness.connectivity.message || 'connectivity validation failed'}`
        );
      }
    }

    const activeTenantId = readiness.tenantId ?? (await profileStore.getData()).activeTenantId;
    const secretStoreReady = await getSecretStore();
    const client = createXyteClient({
      profileStore,
      secretStore: secretStoreReady,
      tenantId: activeTenantId
    });

    await runTui({
      client,
      profileStore,
      secretStore: secretStoreReady,
      initialScreen: 'dashboard',
      headless: false,
      tenantId: activeTenantId
    });
  });

  const doctor = program.command('doctor').description('Runtime diagnostics');

  doctor
    .command('install')
    .description('Check global xyte-cli command wiring')
    .option('--format <format>', 'json|text', 'json')
    .action((options: { format?: OutputFormat }) => {
      const report = runInstallDoctor();
      if ((options.format ?? 'json') === 'text') {
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
      printJson(stdout, report);
    });

  program
    .command('status')
    .description('Fast readiness status for operators and agents')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--mode <mode>', 'fast|full', 'fast')
    .option('--format <format>', 'json|text', 'json')
    .action(async (options: { tenant?: string; mode?: string; format?: OutputFormat }) => {
      const format = (options.format ?? 'json').trim().toLowerCase();
      if (format !== 'json' && format !== 'text') {
        throw new Error(`Invalid format: ${options.format}. Use json|text.`);
      }

      const mode = parseStatusMode(options.mode);
      const checkConnectivity = mode === 'full';
      const secretStore = await getSecretStore();
      const client = checkConnectivity ? await withClient(options.tenant) : undefined;
      const readiness = await evaluateReadiness({
        profileStore,
        secretStore,
        tenantId: options.tenant,
        client,
        checkConnectivity
      });
      const payload = buildStatusContract({
        mode,
        checkConnectivity,
        readiness
      });

      if (format === 'text') {
        stdout.write(`Status mode: ${payload.mode}\n`);
        stdout.write(`Generated: ${payload.generatedAtUtc}\n`);
        stdout.write(formatReadinessText(readiness));
        return;
      }

      printJson(stdout, payload);
    });

  program
    .command('upgrade')
    .description('Update xyte-cli and refresh user-scope agent skills')
    .option('--check', 'Check current and latest version without upgrading')
    .option('--yes', 'Skip confirmation prompt')
    .option('--format <format>', 'json|text', 'json')
    .action(async (options: { check?: boolean; yes?: boolean; format?: OutputFormat }) => {
      const format = (options.format ?? 'json').trim().toLowerCase();
      if (format !== 'json' && format !== 'text') {
        throw new Error(`Invalid format: ${options.format}. Use json|text.`);
      }

      const latestVersionOverride = process.env.XYTE_CLI_UPGRADE_TARGET_VERSION?.trim() || undefined;
      const installSpec = process.env.XYTE_CLI_UPGRADE_SPEC?.trim() || undefined;
      const check = await checkForUpgrade(
        { packageName: '@xyteai/cli', latestVersionOverride },
        runtime.upgradeDependencies
      );
      if (options.check) {
        if (format === 'text') {
          stdout.write(`Package: ${check.packageName}\n`);
          stdout.write(`Current: ${check.currentVersion}\n`);
          stdout.write(`Latest: ${check.latestVersion}\n`);
          stdout.write(`Up to date: ${check.upToDate}\n`);
          if (check.recommendedCommand) {
            stdout.write(`Recommended: ${check.recommendedCommand}\n`);
          }
          return;
        }
        printJson(stdout, check);
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
          if (format === 'text') {
            stdout.write('Upgrade canceled.\n');
          } else {
            printJson(stdout, check);
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

      if (format === 'text') {
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

      printJson(stdout, result);
    });

  program
    .command('list-endpoints')
    .description('List endpoint keys')
    .option('--tenant <tenantId>', 'Filter endpoints available for tenant credentials')
    .action(async (options: { tenant?: string }) => {
      if (options.tenant) {
        const client = await withClient(options.tenant);
        printJson(stdout, await client.listTenantEndpoints(options.tenant));
        return;
      }
      printJson(stdout, listEndpoints());
    });

  program
    .command('describe-endpoint')
    .argument('<key>', 'Endpoint key')
    .description('Describe endpoint metadata')
    .action((key: string) => {
      printJson(stdout, getEndpoint(key));
    });

  program
    .command('call')
    .argument('<key>', 'Endpoint key')
    .description('Call endpoint by key')
    .option('--tenant <tenantId>', 'Tenant id')
    .option('--path-json <json>', 'Path params JSON object')
    .option('--query-json <json>', 'Query params JSON object')
    .option('--body-json <json>', 'Body JSON object')
    .option('--allow-write', 'Allow mutation endpoint invocation')
    .option('--confirm <token>', 'Confirm token required for destructive operations')
    .option('--output-mode <mode>', 'raw|envelope', 'raw')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async (key: string, options: Record<string, unknown>) => {
      const endpoint = getEndpoint(key);
      const method = endpoint.method.toUpperCase();
      const outputMode = String(options.outputMode ?? 'raw');
      if (!['raw', 'envelope'].includes(outputMode)) {
        throw new Error(`Invalid output mode: ${outputMode}. Use raw|envelope.`);
      }
      const requestId = randomUUID();
      const tenantId = options.tenant as string | undefined;
      const path = parsePathJson(options.pathJson as string | undefined);
      const query = parseQueryJson(options.queryJson as string | undefined);
      const body = options.bodyJson ? JSON.parse(String(options.bodyJson)) : undefined;
      const allowWrite = options.allowWrite === true;
      const confirmToken = options.confirm as string | undefined;
      const strictJson = options.strictJson === true;

      try {
        if (requiresWriteGuard(method) && !allowWrite) {
          throw new Error(`Endpoint ${key} is a write operation (${method}). Re-run with --allow-write.`);
        }

        if (requiresDestructiveGuard(method) && confirmToken !== key) {
          throw new Error(`Endpoint ${key} is destructive. Re-run with --confirm ${key}.`);
        }

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
              allowWrite,
              confirm: confirmToken
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
            allowWrite,
            confirm: confirmToken
          },
          request: {
            path,
            query,
            body
          },
          error: toProblemDetails(error, `/call/${key}`)
        });
        printJson(stdout, envelope, { strictJson });
        process.exitCode = 1;
      }
    });

  program
    .command('watch')
    .description('Continuously watch incident deltas as NDJSON frames')
    .option('--tenant <tenantId>', 'Tenant id')
    .option('--profile <profile>', 'incidents-active', 'incidents-active')
    .option('--query-json <json>', 'Query params JSON object (merged over profile defaults)')
    .option('--interval-ms <ms>', 'Polling interval in ms (minimum 1000)', '2000')
    .option('--max-polls <n>', 'Stop after N polls (maximum 3600, default bounded)')
    .option('--once', 'Run one poll and exit')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(
      async (options: {
        tenant?: string;
        profile?: string;
        queryJson?: string;
        intervalMs?: string;
        maxPolls?: string;
        once?: boolean;
        strictJson?: boolean;
      }) => {
        const profile = parseWatchProfile(options.profile);
        const intervalMs = parseWatchIntervalMs(options.intervalMs);
        const maxPolls = parseWatchMaxPolls(options.maxPolls);
        const query = parseQueryJson(options.queryJson);
        const strictJson = options.strictJson === true;
        const tenantId = options.tenant;

        const client = await withClient(tenantId);
        await runWatch({
          client,
          tenantId,
          profile,
          query,
          intervalMs,
          once: options.once === true,
          maxPolls,
          onFrame: (frame) => printJson(stdout, frame, { strictJson, compact: true })
        });
      }
    );

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
    .option('--apply', 'Guarded apply mode')
    .option('--allow-write', 'Allow write steps after explicit gate approval')
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
          allowWrite?: boolean;
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
          allowWrite: options.allowWrite === true,
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

  const utility = program.command('utility').description('Utility preprocessing helpers');

  utility
    .command('prepare')
    .description('Build utility preprocessing contract and scaffold canonical files for one action')
    .requiredOption('--input <path>', 'Input source path')
    .requiredOption('--action <actionKey>', 'Action key (endpoint key or space.import-tree)')
    .option('--tenant <tenantId>', 'Tenant id used in suggested command strings')
    .option('--output-dir <path>', 'Directory for scaffolded files')
    .option('--primary-format <format>', 'csv|jsonl')
    .option('--force', 'Overwrite scaffold files if they already exist')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(
      async (options: {
        input: string;
        action: string;
        tenant?: string;
        outputDir?: string;
        primaryFormat?: string;
        force?: boolean;
        strictJson?: boolean;
      }) => {
        const result = buildUtilityPrepare({
          inputPath: options.input,
          actionKey: options.action,
          outputDir: options.outputDir,
          tenantId: options.tenant,
          primaryFormat: parseUtilityPreparePrimaryFormat(options.primaryFormat),
          force: options.force === true
        });
        printJson(stdout, result, { strictJson: options.strictJson });
      }
    );

  utility
    .command('list-actions')
    .description('List utility prepare action keys')
    .option('--format <format>', 'text|json', 'text')
    .option('--entity <entity>', 'Filter by entity (devices|spaces|tickets|commands|...)')
    .option('--include-generic', 'Include generic profiles', true)
    .option('--no-include-generic', 'Exclude generic profiles')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async (options: { format?: string; entity?: string; includeGeneric?: boolean; strictJson?: boolean }) => {
      const format = (options.format ?? 'text').trim().toLowerCase();
      if (format !== 'text' && format !== 'json') {
        throw new Error(`Invalid format: ${options.format}. Use text|json.`);
      }

      const actions = listUtilityPrepareActions({
        entity: options.entity,
        includeGeneric: options.includeGeneric !== false
      });

      if (format === 'json') {
        printJson(stdout, actions, { strictJson: options.strictJson });
        return;
      }

      if (!actions.length) {
        stdout.write('No utility actions found.\n');
        return;
      }

      for (const action of actions) {
        stdout.write(
          `${action.actionKey} | entity=${action.entity} | mode=${action.mode} | execution=${action.executionSupport}\n`
        );
      }
    });

  const space = program.command('space').description('Space utility operations');

  space
    .command('import-tree')
    .description('Create or find spaces from file-defined paths (prepare-first: run `xyte-cli utility prepare --action space.import-tree`)')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .requiredOption('--input <path>', 'Input path (CSV/JSON/JSONL)')
    .option('--input-format <format>', 'auto|csv|json|jsonl', 'auto')
    .option('--path-field <name>', 'Input column/field for full path', 'path')
    .option('--space-type-field <name>', 'Input column/field for space type', 'space_type')
    .option('--config-field <name>', 'Input column/field for config object', 'config')
    .option('--apply', 'Apply changes (default is dry-run)')
    .option('--continue-on-error', 'Continue processing rows after failures')
    .option('--report <path>', 'Write NDJSON row report file')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(
      async (options: {
        tenant: string;
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
        const client = await withClient(options.tenant);
        const result = await runSpaceImportTree({
          client,
          tenantId: options.tenant,
          inputPath: options.input,
          inputFormat: parseUtilityInputFormat(options.inputFormat),
          apply: options.apply === true,
          continueOnError: options.continueOnError === true,
          reportPath: options.report,
          pathField: options.pathField,
          spaceTypeField: options.spaceTypeField,
          configField: options.configField
        });
        printJson(stdout, result, { strictJson: options.strictJson });
        if (result.totals.failed > 0) {
          process.exitCode = 1;
        }
      }
    );

  const inspect = program.command('inspect').description('Deterministic fleet insights');

  inspect
    .command('fleet')
    .description('Build a fleet summary snapshot')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .option('--provider-scope <scope>', 'organization|partner|auto', 'auto')
    .option('--format <format>', 'json|ascii', 'json')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async (options: { tenant: string; providerScope?: string; format?: string; strictJson?: boolean }) => {
      const format = options.format ?? 'json';
      if (!['json', 'ascii'].includes(format)) {
        throw new Error(`Invalid format: ${format}. Use json|ascii.`);
      }
      const providerScope = parseInspectProviderScope(options.providerScope);
      const client = await withClient(options.tenant);
      const tenantProfile = await profileStore.getTenant(options.tenant);
      const snapshot = await collectFleetSnapshot(client, options.tenant, tenantProfile?.name, providerScope);
      const result = buildFleetInspect(snapshot);

      if (format === 'ascii') {
        stdout.write(`${formatFleetInspectAscii(result)}\n`);
        return;
      }

      printJson(stdout, result, { strictJson: options.strictJson });
    });

  inspect
    .command('deep-dive')
    .description('Build deep-dive operational analytics')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .option('--provider-scope <scope>', 'organization|partner|auto', 'auto')
    .option('--window <hours>', 'Window in hours', '24')
    .option('--format <format>', 'json|ascii|markdown', 'json')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async (options: { tenant: string; providerScope?: string; window?: string; format?: string; strictJson?: boolean }) => {
      const format = options.format ?? 'json';
      if (!['json', 'ascii', 'markdown'].includes(format)) {
        throw new Error(`Invalid format: ${format}. Use json|ascii|markdown.`);
      }
      const windowHours = Number.parseInt(options.window ?? '24', 10);
      const providerScope = parseInspectProviderScope(options.providerScope);
      const client = await withClient(options.tenant);
      const tenantProfile = await profileStore.getTenant(options.tenant);
      const snapshot = await collectFleetSnapshot(client, options.tenant, tenantProfile?.name, providerScope);
      const result = buildDeepDive(snapshot, Number.isFinite(windowHours) ? windowHours : 24);

      if (format === 'ascii') {
        stdout.write(`${formatDeepDiveAscii(result)}\n`);
        return;
      }
      if (format === 'markdown') {
        stdout.write(`${formatDeepDiveMarkdown(result, false)}\n`);
        return;
      }
      printJson(stdout, result, { strictJson: options.strictJson });
    });

  const report = program.command('report').description('Generate fleet findings reports');

  report
    .command('generate')
    .description('Generate report from deep-dive JSON input')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .requiredOption('--input <path>', 'Path to deep-dive JSON input')
    .requiredOption('--out <path>', 'Output path')
    .option('--format <format>', 'markdown|pdf', 'pdf')
    .option('--include-sensitive', 'Include full ticket/device IDs in report')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(
      async (options: {
        tenant: string;
        input: string;
        out: string;
        format?: 'markdown' | 'pdf';
        includeSensitive?: boolean;
        strictJson?: boolean;
      }) => {
        const raw = JSON.parse(readFileSync(path.resolve(options.input), 'utf8')) as {
          schemaVersion?: string;
          tenantId?: string;
          windowHours?: number;
        };
        const format = options.format ?? 'pdf';
        if (!['markdown', 'pdf'].includes(format)) {
          throw new Error(`Invalid format: ${format}. Use markdown|pdf.`);
        }

        if (raw.schemaVersion !== 'xyte.inspect.deep-dive.v1') {
          throw new Error('Input JSON must be produced by `xyte-cli inspect deep-dive --format json`.');
        }

        if (raw.tenantId && raw.tenantId !== options.tenant) {
          throw new Error(`Input tenant mismatch. Expected ${options.tenant}, got ${raw.tenantId}.`);
        }

        if (!('tenantName' in raw) || typeof (raw as { tenantName?: unknown }).tenantName !== 'string') {
          const tenantProfile = await profileStore.getTenant(options.tenant);
          if (tenantProfile?.name) {
            (raw as { tenantName?: string }).tenantName = tenantProfile.name;
          }
        }

        const generated = await generateFleetReport({
          deepDive: raw as any,
          format: format as 'markdown' | 'pdf',
          outPath: options.out,
          includeSensitive: options.includeSensitive === true
        });
        printJson(stdout, generated, { strictJson: options.strictJson });
      }
    );

  const tenant = program.command('tenant').description('Manage tenant profiles');

  tenant
    .command('add')
    .argument('<tenantId>', 'Tenant id')
    .description('Create or update a tenant profile')
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

  tenant
    .command('list')
    .description('List tenants')
    .action(async () => {
      const data = await profileStore.getData();
      printJson(stdout, {
        activeTenantId: data.activeTenantId,
        tenants: data.tenants
      });
    });

  tenant
    .command('use')
    .argument('<tenantId>', 'Tenant id to set active')
    .description('Set active tenant')
    .action(async (tenantId: string) => {
      await profileStore.setActiveTenant(tenantId);
      stdout.write(`Active tenant set to ${tenantId}\n`);
    });

  tenant
    .command('remove')
    .argument('<tenantId>', 'Tenant id')
    .description('Remove tenant profile')
    .action(async (tenantId: string) => {
      await profileStore.removeTenant(tenantId);
      stdout.write(`Removed tenant ${tenantId}\n`);
    });

  const profile = program.command('profile').description('Manage profile settings');

  profile
    .command('set-default')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .description('Set active default tenant')
    .action(async (options: { tenant: string }) => {
      await profileStore.setActiveTenant(options.tenant);
      stdout.write(`Default tenant set to ${options.tenant}\n`);
    });

  const auth = program.command('auth').description('Manage API keys in persistent secret store');
  const authKey = auth.command('key').description('Manage named key slots');

  authKey
    .command('add')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .requiredOption('--provider <provider>', SUPPORTED_SECRET_PROVIDERS.join('|'))
    .requiredOption('--name <name>', 'Slot display name')
    .option('--slot-id <slotId>', 'Optional explicit slot id')
    .option('--key <value>', 'API key value')
    .option('--set-active', 'Set as active slot for provider')
    .action(async (options: { tenant: string; provider: string; name: string; slotId?: string; key?: string; setActive?: boolean }) => {
      const provider = parseProvider(options.provider);
      const value = requireKeyValue(options.key);
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

  authKey
    .command('list')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .option('--provider <provider>', 'Optional provider filter')
    .option('--format <format>', 'json|text', 'json')
    .action(async (options: { tenant: string; provider?: string; format?: OutputFormat }) => {
      const secretStore = await getSecretStore();
      const provider = options.provider ? parseProvider(options.provider) : undefined;
      const slots = await collectSlotViews({
        profileStore,
        secretStore,
        tenantId: options.tenant,
        provider
      });

      if ((options.format ?? 'json') === 'text') {
        stdout.write(formatSlotListText(slots));
        return;
      }

      printJson(stdout, {
        tenantId: options.tenant,
        slots
      });
    });

  authKey
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

  authKey
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

  authKey
    .command('update')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .requiredOption('--provider <provider>', 'Provider')
    .requiredOption('--slot <slotRef>', 'Slot id or name')
    .option('--key <value>', 'API key value')
    .action(async (options: { tenant: string; provider: string; slot: string; key?: string }) => {
      const provider = parseProvider(options.provider);
      const slot = await resolveSlotByRef(profileStore, options.tenant, provider, options.slot);
      const value = requireKeyValue(options.key);
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

  authKey
    .command('remove')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .requiredOption('--provider <provider>', 'Provider')
    .requiredOption('--slot <slotRef>', 'Slot id or name')
    .option('--confirm', 'Confirm removal')
    .action(async (options: { tenant: string; provider: string; slot: string; confirm?: boolean }) => {
      if (!options.confirm) {
        throw new Error('Key slot removal is destructive. Re-run with --confirm.');
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

  authKey
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
        throw new Error(`No secret found for slot "${slot.slotId}" (${provider}) in tenant ${options.tenant}.`);
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

  const setup = program.command('setup').description('Run setup and readiness checks');

  setup
    .command('status')
    .description('Show setup/readiness status')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--format <format>', 'json|text', 'json')
    .action(async (options: { tenant?: string; format?: OutputFormat }) => {
      const secretStore = await getSecretStore();
      const client = await withClient(options.tenant);
      const readiness = await evaluateReadiness({
        profileStore,
        secretStore,
        tenantId: options.tenant,
        client,
        checkConnectivity: true
      });

      if ((options.format ?? 'json') === 'text') {
        stdout.write(formatReadinessText(readiness));
        return;
      }
      printJson(stdout, readiness);
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
    .option('--set-active', 'Set slot active (default true in setup flow)')
    .option('--connectivity <mode>', 'auto|always|never', 'auto')
    .option('--non-interactive', 'Disable prompts and require needed options')
    .option('--format <format>', 'json|text', 'json')
    .action(
      async (options: {
        tenant?: string;
        name?: string;
        advanced?: boolean;
        provider?: string;
        slotName?: string;
        key?: string;
        setActive?: boolean;
        connectivity?: string;
        nonInteractive?: boolean;
        format?: OutputFormat;
      }) => {
        if (!options.nonInteractive && !isInteractive) {
          throw new Error('Interactive setup requires a TTY. Use --non-interactive with explicit flags.');
        }

        const explicitTenantName = typeof options.name === 'string' && options.name.trim().length > 0;
        const connectivityMode = parseSetupConnectivityMode(options.connectivity);
        // Provider selection only exists in advanced setup; honor explicit --provider by switching modes automatically.
        const advanced = options.advanced === true || options.provider !== undefined;
        if (!advanced) {
          let tenantLabel = (options.name ?? options.tenant ?? SIMPLE_SETUP_DEFAULT_TENANT).trim() || SIMPLE_SETUP_DEFAULT_TENANT;
          let keyValue = options.key ?? process.env.XYTE_CLI_KEY;

          if (!options.nonInteractive) {
            keyValue = keyValue || (await prompt({ question: 'XYTE API key', stdout }));
            tenantLabel =
              (await prompt({
                question: 'Tenant label (optional)',
                initial: tenantLabel,
                stdout
              })) || tenantLabel;
          }

          if (!keyValue) {
            throw new Error('Missing API key. Provide --key/XYTE_CLI_KEY (or run interactive setup).');
          }

          const tenantId = normalizeTenantId(options.tenant?.trim() || tenantLabel);
          const tenantName = tenantLabel.trim() || tenantId;
          const resolvedTenantName =
            !explicitTenantName && tenantName === tenantId
              ? await resolveTenantNameFromKey({
                  tenantId,
                  provider: SIMPLE_SETUP_PROVIDER,
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

          if ((options.format ?? 'json') === 'text') {
            stdout.write(formatReadinessText(setupResult.readiness));
            return;
          }

          printJson(stdout, setupResult);
          return;
        }

        let tenantId = options.tenant;
        let tenantName = options.name;
        let provider = options.provider ? parseProvider(options.provider) : undefined;
        let slotName = options.slotName ?? 'primary';
        let keyValue = options.key ?? process.env.XYTE_CLI_KEY;
        const steps: SetupStep[] = [];

        if (!options.nonInteractive) {
          tenantId = tenantId || (await prompt({ question: 'Tenant id', stdout }));
          tenantName = tenantName || (await prompt({ question: 'Tenant display name', initial: tenantId, stdout }));
          const providerAnswer = provider || parseProvider(await prompt({ question: 'Provider', initial: 'xyte-org', stdout }));
          provider = providerAnswer;
          slotName = await prompt({ question: 'Slot name', initial: slotName, stdout });
          keyValue = keyValue || (await prompt({ question: 'API key', stdout }));
        }

        if (!tenantId) {
          throw new Error('Missing tenant id. Provide --tenant (or run interactive setup).');
        }
        if (!provider) {
          throw new Error('Missing provider. Provide --provider (or run interactive setup).');
        }
        if (!keyValue) {
          throw new Error('Missing API key. Provide --key/XYTE_CLI_KEY (or run interactive setup).');
        }

        const candidateTenantName = (tenantName?.trim() || tenantId).trim() || tenantId;
        const resolvedTenantName =
          !explicitTenantName && candidateTenantName === tenantId
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

        if ((options.format ?? 'json') === 'text') {
          stdout.write(formatReadinessText(readiness));
          return;
        }

        printJson(stdout, {
          tenantId,
          provider,
          slot,
          readiness,
          connectivityMode,
          steps
        });
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
    .action(async (options: { tenant?: string; retryAttempts?: string; retryBackoffMs?: string; format?: OutputFormat }) => {
      const retryAttempts = Number.parseInt(options.retryAttempts ?? '2', 10);
      const retryBackoffMs = Number.parseInt(options.retryBackoffMs ?? '250', 10);
      const secretStore = await getSecretStore();
      const client = await withClient(options.tenant, {
        attempts: Number.isFinite(retryAttempts) ? retryAttempts : 2,
        backoffMs: Number.isFinite(retryBackoffMs) ? retryBackoffMs : 250
      });

      const readiness = await evaluateReadiness({
        profileStore,
        secretStore,
        tenantId: options.tenant,
        client,
        checkConnectivity: true
      });

      if ((options.format ?? 'json') === 'text') {
        stdout.write(formatReadinessText(readiness));
        return;
      }

      printJson(stdout, {
        retryAttempts,
        retryBackoffMs,
        readiness
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
      (options: {
        path?: string;
        limit?: string;
        event?: string;
        command?: string;
        format?: string;
      }) => {
        const format = (options.format ?? 'text').trim().toLowerCase();
        if (format !== 'text' && format !== 'json') {
          throw new Error(`Invalid format: ${options.format}. Use text|json.`);
        }

        const limit = parsePositiveIntegerOption(options.limit, 100, 'limit');
        const result = readCliActionLog({
          path: options.path,
          limit,
          event: options.event,
          command: options.command
        });

        if (format === 'json') {
          printJson(stdout, {
            schemaVersion: 'xyte.cli.action-log.v1',
            path: result.path,
            count: result.entries.length,
            parseErrors: result.parseErrors,
            entries: result.entries
          });
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
    .action((options: { path?: string; format?: string }) => {
      const format = (options.format ?? 'text').trim().toLowerCase();
      if (format !== 'text' && format !== 'json') {
        throw new Error(`Invalid format: ${options.format}. Use text|json.`);
      }

      const path = resolveCliActionLogPath(options.path);
      const files = listCliActionLogFiles(path);
      const totalBytes = files.reduce((sum, item) => sum + item.sizeBytes, 0);

      if (format === 'json') {
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
        });
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
      (options: {
        path?: string;
        maxFiles?: string;
        maxAgeDays?: string;
        dryRun?: boolean;
        format?: string;
      }) => {
        const format = (options.format ?? 'text').trim().toLowerCase();
        if (format !== 'text' && format !== 'json') {
          throw new Error(`Invalid format: ${options.format}. Use text|json.`);
        }

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

        if (format === 'json') {
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
          });
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

  program
    .command('tui')
    .description('Launch the full-screen TUI')
    .option('--headless', 'Run headless visual mode for agents')
    .option('--screen <screen>', 'setup|config|dashboard|spaces|devices|incidents|tickets', 'dashboard')
    .option('--format <format>', 'json|text (headless is json-only)', 'json')
    .option('--once', 'Render one frame and exit (default behavior)')
    .option('--follow', 'Continuously stream frames')
    .option('--interval-ms <ms>', 'Polling interval for --follow', '2000')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--no-motion', 'Disable motion and animation effects')
    .option('--debug', 'Enable TUI debug logging')
    .option('--debug-log <path>', 'Write TUI debug logs to this file')
    .action(async (options: {
      headless?: boolean;
      screen?: string;
      format?: string;
      once?: boolean;
      follow?: boolean;
      intervalMs?: string;
      tenant?: string;
      motion?: boolean;
      debug?: boolean;
      debugLog?: string;
    }) => {
      const secretStore = await getSecretStore();
      const client = createXyteClient({ profileStore, secretStore });

      const allowedScreens: TuiScreenId[] = ['setup', 'config', 'dashboard', 'spaces', 'devices', 'incidents', 'tickets'];
      const screen = (options.screen ?? 'dashboard') as TuiScreenId;
      if (!allowedScreens.includes(screen)) {
        throw new Error(`Invalid screen: ${options.screen}`);
      }

      const format = options.format ?? 'json';
      if (Boolean(options.headless)) {
        if (format !== 'json') {
          throw new Error('Headless mode is JSON-only. Use --format json and parse NDJSON frames.');
        }
      } else if (!['json', 'text'].includes(format)) {
        throw new Error(`Invalid format: ${options.format}.`);
      }

      const follow = options.once ? false : Boolean(options.follow);
      const intervalMs = Number.parseInt(options.intervalMs ?? '2000', 10);
      const motionEnabled = options.motion === false ? false : undefined;

      await runTui({
        client,
        profileStore,
        secretStore,
        initialScreen: screen,
        headless: Boolean(options.headless),
        format: (options.headless ? 'json' : format) as OutputFormat,
        motionEnabled,
        follow,
        intervalMs: Number.isFinite(intervalMs) ? intervalMs : 2000,
        tenantId: options.tenant,
        output: stdout,
        debug: options.debug,
        debugLogPath: options.debugLog
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
