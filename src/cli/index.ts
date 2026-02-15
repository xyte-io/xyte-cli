import { createInterface } from 'node:readline/promises';
import { accessSync, constants, existsSync, readFileSync, realpathSync } from 'node:fs';
import { delimiter } from 'node:path';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { Command } from 'commander';

import { createXyteClient } from '../client/create-client';
import { getEndpoint, listEndpoints } from '../client/catalog';
import { buildCallEnvelope } from '../contracts/call-envelope';
import { toProblemDetails } from '../contracts/problem';
import { evaluateReadiness, type ReadinessCheck } from '../config/readiness';
import { createKeychainStore, type KeychainStore } from '../secure/keychain';
import { makeKeyFingerprint, matchesSlotRef } from '../secure/key-slots';
import { FileProfileStore, type ProfileStore } from '../secure/profile-store';
import type { SecretProvider } from '../types/profile';
import { parseJsonObject } from '../utils/json';
import { writeJsonLine } from '../utils/json-output';
import {
  installSkills,
  type SkillAgent,
  type SkillInstallOutcome,
  type SkillInstallScope
} from '../utils/install-skills';
import { runTuiApp } from '../tui/app';
import type { TuiScreenId } from '../tui/types';
import {
  buildDeepDive,
  buildFleetInspect,
  collectFleetSnapshot,
  formatDeepDiveAscii,
  formatDeepDiveMarkdown,
  formatFleetInspectAscii,
  generateFleetReport
} from '../workflows/fleet-insights';
import { createMcpServer } from '../mcp/server';

type OutputStream = Pick<typeof process.stdout, 'write'>;
type ErrorStream = Pick<typeof process.stderr, 'write'>;
type OutputFormat = 'json' | 'text';
type PromptValueFn = (args: { question: string; initial?: string; stdout: OutputStream }) => Promise<string>;

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

export interface CliRuntime {
  profileStore?: ProfileStore;
  keychain?: KeychainStore;
  stdout?: OutputStream;
  stderr?: ErrorStream;
  runTui?: typeof runTuiApp;
  promptValue?: PromptValueFn;
  isTTY?: boolean;
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

function printJson(stream: OutputStream, value: unknown, options: { strictJson?: boolean } = {}) {
  writeJsonLine(stream, value, { strictJson: options.strictJson });
}

function parseProvider(value: string): SecretProvider {
  const allowed: SecretProvider[] = ['xyte-org', 'xyte-partner', 'xyte-device'];

  if (!allowed.includes(value as SecretProvider)) {
    throw new Error(`Invalid provider: ${value}`);
  }

  return value as SecretProvider;
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
  const expectedPath = path.resolve(__dirname, '../../bin/xyte-cli');
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
  keychain: KeychainStore;
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
    const hasSecret = Boolean(await args.keychain.getSlotSecret(args.tenantId, slot.provider, slot.slotId));
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

  if (args.provider === 'xyte-device') {
    return {
      strategy: 'local-only',
      ok: true,
      note: 'Device-key probe skipped (requires device-specific path context).'
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

  let keychainPromise: Promise<KeychainStore> | undefined;
  const getKeychain = async () => {
    if (runtime.keychain) {
      return runtime.keychain;
    }
    if (!keychainPromise) {
      keychainPromise = createKeychainStore();
    }
    return keychainPromise;
  };

  const withClient = async (tenantId?: string, retry?: { attempts?: number; backoffMs?: number }) => {
    const keychain = await getKeychain();
    return createXyteClient({
      profileStore,
      keychain,
      tenantId,
      retryAttempts: retry?.attempts,
      retryBackoffMs: retry?.backoffMs
    });
  };

  const runSimpleSetup = async (args: {
    tenantId: string;
    tenantName: string;
    keyValue: string;
    setActive?: boolean;
  }) => {
    await profileStore.upsertTenant({
      id: args.tenantId,
      name: args.tenantName
    });
    await profileStore.setActiveTenant(args.tenantId);

    const keychain = await getKeychain();
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

    await keychain.setSlotSecret(args.tenantId, SIMPLE_SETUP_PROVIDER, slot.slotId, args.keyValue);
    if (args.setActive !== false) {
      await profileStore.setActiveKeySlot(args.tenantId, SIMPLE_SETUP_PROVIDER, slot.slotId);
    }

    const client = await withClient(args.tenantId);
    const readiness = await evaluateReadiness({
      profileStore,
      keychain,
      tenantId: args.tenantId,
      client,
      checkConnectivity: true
    });

    return {
      tenantId: args.tenantId,
      provider: SIMPLE_SETUP_PROVIDER,
      slot,
      readiness
    };
  };

  const program = new Command();
  program.name('xyte-cli').description('Xyte CLI + TUI').version('0.1.0');
  program.option('--error-format <format>', 'text|json', 'text');

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

        const skillSource = path.resolve(__dirname, '../../skills/xyte-cli');
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
          setActive: true
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
    const keychain = await getKeychain();
    const readinessClient = await withClient(undefined);
    const readiness = await evaluateReadiness({
      profileStore,
      keychain,
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
        setActive: true
      });

      if (setupResult.readiness.state !== 'ready') {
        throw new Error(
          `Setup did not complete: ${setupResult.readiness.connectivity.message || 'connectivity validation failed'}`
        );
      }
    }

    const activeTenantId = readiness.tenantId ?? (await profileStore.getData()).activeTenantId;
    const keychainReady = await getKeychain();
    const client = createXyteClient({
      profileStore,
      keychain: keychainReady,
      tenantId: activeTenantId
    });

    await runTui({
      client,
      profileStore,
      keychain: keychainReady,
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

  const inspect = program.command('inspect').description('Deterministic fleet insights');

  inspect
    .command('fleet')
    .description('Build a fleet summary snapshot')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .option('--format <format>', 'json|ascii', 'json')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async (options: { tenant: string; format?: string; strictJson?: boolean }) => {
      const format = options.format ?? 'json';
      if (!['json', 'ascii'].includes(format)) {
        throw new Error(`Invalid format: ${format}. Use json|ascii.`);
      }
      const client = await withClient(options.tenant);
      const snapshot = await collectFleetSnapshot(client, options.tenant);
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
    .option('--window <hours>', 'Window in hours', '24')
    .option('--format <format>', 'json|ascii|markdown', 'json')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async (options: { tenant: string; window?: string; format?: string; strictJson?: boolean }) => {
      const format = options.format ?? 'json';
      if (!['json', 'ascii', 'markdown'].includes(format)) {
        throw new Error(`Invalid format: ${format}. Use json|ascii|markdown.`);
      }
      const windowHours = Number.parseInt(options.window ?? '24', 10);
      const client = await withClient(options.tenant);
      const snapshot = await collectFleetSnapshot(client, options.tenant);
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

        const generated = await generateFleetReport({
          deepDive: raw as any,
          format: format as 'markdown' | 'pdf',
          outPath: options.out,
          includeSensitive: options.includeSensitive === true
        });
        printJson(stdout, generated, { strictJson: options.strictJson });
      }
    );

  const mcp = program.command('mcp').description('Model Context Protocol tools');
  mcp
    .command('serve')
    .description('Run MCP server over stdio')
    .action(async () => {
      const keychain = await getKeychain();
      const server = createMcpServer({
        profileStore,
        keychain
      });
      await server.start();
    });

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

  const auth = program.command('auth').description('Manage API keys in OS keychain');
  const authKey = auth.command('key').description('Manage named key slots');

  authKey
    .command('add')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .requiredOption('--provider <provider>', 'xyte-org|xyte-partner|xyte-device')
    .requiredOption('--name <name>', 'Slot display name')
    .option('--slot-id <slotId>', 'Optional explicit slot id')
    .option('--key <value>', 'API key value')
    .option('--set-active', 'Set as active slot for provider')
    .action(async (options: { tenant: string; provider: string; name: string; slotId?: string; key?: string; setActive?: boolean }) => {
      const provider = parseProvider(options.provider);
      const value = requireKeyValue(options.key);
      await profileStore.upsertTenant({ id: options.tenant });
      const keychain = await getKeychain();

      const slot = await profileStore.addKeySlot(options.tenant, {
        provider,
        name: options.name,
        slotId: options.slotId,
        fingerprint: makeKeyFingerprint(value)
      });

      await keychain.setSlotSecret(options.tenant, provider, slot.slotId, value);
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
      const keychain = await getKeychain();
      const provider = options.provider ? parseProvider(options.provider) : undefined;
      const slots = await collectSlotViews({
        profileStore,
        keychain,
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
      const keychain = await getKeychain();

      await keychain.setSlotSecret(options.tenant, provider, slot.slotId, value);
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
      const keychain = await getKeychain();

      await keychain.clearSlotSecret(options.tenant, provider, slot.slotId);
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
      const keychain = await getKeychain();
      const secret = await keychain.getSlotSecret(options.tenant, provider, slot.slotId);

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
      const keychain = await getKeychain();
      const client = await withClient(options.tenant);
      const readiness = await evaluateReadiness({
        profileStore,
        keychain,
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
        nonInteractive?: boolean;
        format?: OutputFormat;
      }) => {
        if (!options.nonInteractive && !isInteractive) {
          throw new Error('Interactive setup requires a TTY. Use --non-interactive with explicit flags.');
        }

        const advanced = options.advanced === true;
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
          const setupResult = await runSimpleSetup({
            tenantId,
            tenantName,
            keyValue,
            setActive: options.setActive !== false
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

        await profileStore.upsertTenant({
          id: tenantId,
          name: tenantName
        });
        await profileStore.setActiveTenant(tenantId);
        const keychain = await getKeychain();

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
        await keychain.setSlotSecret(tenantId, provider, slot.slotId, keyValue);

        if (options.setActive !== false) {
          await profileStore.setActiveKeySlot(tenantId, provider, slot.slotId);
        }

        const client = await withClient(tenantId);
        const readiness = await evaluateReadiness({
          profileStore,
          keychain,
          tenantId,
          client,
          checkConnectivity: true
        });

        if ((options.format ?? 'json') === 'text') {
          stdout.write(formatReadinessText(readiness));
          return;
        }

        printJson(stdout, {
          tenantId,
          provider,
          slot,
          readiness
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
      const keychain = await getKeychain();
      const client = await withClient(options.tenant, {
        attempts: Number.isFinite(retryAttempts) ? retryAttempts : 2,
        backoffMs: Number.isFinite(retryBackoffMs) ? retryBackoffMs : 250
      });

      const readiness = await evaluateReadiness({
        profileStore,
        keychain,
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
      const keychain = await getKeychain();
      const client = createXyteClient({ profileStore, keychain });

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
        keychain,
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

  program.exitOverride((error) => {
    if (error.code === 'commander.helpDisplayed') {
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
  await program.parseAsync(argv);
}
