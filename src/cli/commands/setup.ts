import type { Command } from 'commander';

import { createXyteClient } from '../../client/create-client';
import { evaluateReadiness, type ReadinessCheck } from '../../config/readiness';
import { makeKeyFingerprint } from '../../secure/key-slots';
import type { ApiKeySlotMeta, SecretProvider } from '../../types/profile';
import { parseProvider, PROVIDER_ORG } from '../../types/profile';
import { isRecord } from '../../utils/json';
import { firstText } from '../../utils/json';
import { CliUserError } from '../../contracts/user-error';
import { formatReadinessText } from '../format-readiness';
import { fetchProviderForKey } from '../provider-resolution';
import { resolveKeyValue } from '../resolve-key';
import {
  type CliContext,
  type OutputFormat,
  getExplicitGlobalOutput,
  printJson,
  resolveStrictJson,
  resolveTextJsonOutput
} from '../cli-context';

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

interface SetupRunResult {
  tenantId: string;
  provider: SecretProvider;
  slot: ApiKeySlotMeta;
  readiness: ReadinessCheck;
  connectivityMode: SetupConnectivityMode;
  steps: SetupStep[];
}

const SIMPLE_SETUP_SLOT_NAME = 'primary';
const SIMPLE_SETUP_DEFAULT_TENANT = 'default';

function parseSetupConnectivityMode(value: string | undefined): SetupConnectivityMode {
  const normalized = (value ?? 'auto').trim().toLowerCase();
  if (normalized !== 'auto' && normalized !== 'always' && normalized !== 'never') {
    throw new Error(`Invalid connectivity mode: ${value}. Use auto|always|never.`);
  }
  return normalized as SetupConnectivityMode;
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
      detail: `Field "${field}" is missing or not a scalar value.`,
      suggestedCommands: ['Use --field tenantId', 'Omit --field to print the full status payload']
    });
  }
  return value === null ? 'null' : String(value);
}

function extractTenantNameFromOrganizationInfo(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }

  const nameKeys = ['name', 'organization_name', 'display_name', 'tenant_name', 'company_name'] as const;
  const readName = (record: Record<string, unknown>): string | undefined =>
    firstText(...nameKeys.map((key) => record[key]));

  const candidates: Record<string, unknown>[] = [payload];
  const directNested = [payload.organization, payload.data, payload.result, payload.payload].filter(isRecord) as Record<
    string,
    unknown
  >[];
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

export { SIMPLE_SETUP_DEFAULT_TENANT, normalizeTenantId, runSimpleSetup };

async function fetchTenantNameFromKey(
  ctx: CliContext,
  args: {
    tenantId: string;
    provider: SecretProvider;
    keyValue: string;
  }
): Promise<string | undefined> {
  if (args.provider !== PROVIDER_ORG) {
    return undefined;
  }

  try {
    const secretStore = ctx.getSecretStore();
    const client = createXyteClient({
      profileStore: ctx.profileStore,
      secretStore,
      auth: { organization: args.keyValue }
    });
    const info = await client.organization.getOrganizationInfo({ tenantId: args.tenantId });
    return extractTenantNameFromOrganizationInfo(info);
  } catch {
    return undefined;
  }
}

async function runSetupCore(
  ctx: CliContext,
  args: {
    tenantId: string;
    tenantName: string;
    provider: SecretProvider;
    slotName: string;
    keyValue: string;
    setActive: boolean;
    connectivityMode: SetupConnectivityMode;
  }
): Promise<SetupRunResult> {
  const steps: SetupStep[] = [];

  await ctx.profileStore.upsertTenant({
    id: args.tenantId,
    name: args.tenantName,
    apiProvider: args.provider
  });
  steps.push({ key: 'tenant_upserted', status: 'ok', detail: args.tenantId });

  await ctx.profileStore.setActiveTenant(args.tenantId);
  steps.push({ key: 'tenant_activated', status: 'ok', detail: args.tenantId });

  const secretStore = ctx.getSecretStore();
  const knownSlots = await ctx.profileStore.listKeySlots(args.tenantId, args.provider);
  const existing = knownSlots.find((s) => s.name.toLowerCase() === args.slotName.toLowerCase());

  const slot = existing
    ? await ctx.profileStore.updateKeySlot(args.tenantId, args.provider, existing.slotId, {
        fingerprint: makeKeyFingerprint(args.keyValue)
      })
    : await ctx.profileStore.addKeySlot(args.tenantId, {
        provider: args.provider,
        name: args.slotName,
        fingerprint: makeKeyFingerprint(args.keyValue)
      });

  await secretStore.setSlotSecret(args.tenantId, args.provider, slot.slotId, args.keyValue);
  steps.push({ key: 'slot_written', status: 'ok', detail: slot.slotId });

  if (args.setActive) {
    await ctx.profileStore.setActiveKeySlot(args.tenantId, args.provider, slot.slotId);
    steps.push({ key: 'slot_activated', status: 'ok', detail: slot.slotId });
  } else {
    steps.push({ key: 'slot_activated', status: 'skipped', detail: 'setActive=false' });
  }

  const checkConnectivity = args.connectivityMode !== 'never';
  const client = checkConnectivity ? await ctx.withClient({ tenantId: args.tenantId }) : undefined;
  const readiness = await evaluateReadiness({
    profileStore: ctx.profileStore,
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
  steps.push({ key: 'readiness_evaluated', status: 'ok', detail: readiness.state });

  return {
    tenantId: args.tenantId,
    provider: args.provider,
    slot,
    readiness,
    connectivityMode: args.connectivityMode,
    steps
  };
}

async function runSimpleSetup(
  ctx: CliContext,
  args: {
    tenantId: string;
    tenantName: string;
    keyValue: string;
    provider?: SecretProvider;
    setActive?: boolean;
    connectivityMode?: SetupConnectivityMode;
  }
): Promise<SetupRunResult> {
  const connectivityMode = args.connectivityMode ?? 'auto';
  const provider =
    args.provider ??
    (await fetchProviderForKey({
      profileStore: ctx.profileStore,
      tenantId: args.tenantId,
      keyValue: args.keyValue,
      allowProbe: connectivityMode !== 'never'
    }));

  return runSetupCore(ctx, {
    tenantId: args.tenantId,
    tenantName: args.tenantName,
    provider,
    slotName: SIMPLE_SETUP_SLOT_NAME,
    keyValue: args.keyValue,
    setActive: args.setActive !== false,
    connectivityMode
  });
}

async function handleSetupStatus(
  ctx: CliContext,
  options: {
    tenant?: string;
    output?: string;
    format?: OutputFormat;
    field?: string;
  }
): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  const secretStore = ctx.getSecretStore();
  const tenantId = options.tenant ?? settings.values.defaults.tenant;
  const client = tenantId ? await ctx.withClient({ tenantId }) : undefined;
  const readiness = await evaluateReadiness({
    profileStore: ctx.profileStore,
    secretStore,
    tenantId,
    client,
    checkConnectivity: true
  });

  if (options.field) {
    const fieldValue = resolveFieldValue(readiness, options.field);
    ctx.stdout.write(`${formatScalarFieldValue(fieldValue, options.field)}\n`);
    return;
  }

  if (
    resolveTextJsonOutput({
      output: options.output,
      format: options.format,
      stdoutIsTTY: ctx.stdoutIsTTY,
      settings
    }) === 'text'
  ) {
    ctx.stdout.write(formatReadinessText(readiness));
    return;
  }
  printJson(ctx.stdout, readiness, { strictJson: resolveStrictJson({ settings }) });
}

async function fetchProviderAndTenantName(
  ctx: CliContext,
  args: {
    tenantId: string;
    candidateTenantName: string;
    keyValue: string;
    provider: SecretProvider | undefined;
    connectivityMode: SetupConnectivityMode;
    explicitTenantName: boolean;
  }
): Promise<{ provider: SecretProvider; tenantName: string }> {
  const resolvedProvider = await fetchProviderForKey({
    profileStore: ctx.profileStore,
    tenantId: args.tenantId,
    keyValue: args.keyValue,
    provider: args.provider,
    allowProbe: args.connectivityMode !== 'never'
  });
  const resolvedTenantName =
    args.connectivityMode !== 'never' && !args.explicitTenantName && args.candidateTenantName === args.tenantId
      ? await fetchTenantNameFromKey(ctx, {
          tenantId: args.tenantId,
          provider: resolvedProvider,
          keyValue: args.keyValue
        })
      : undefined;
  return {
    provider: resolvedProvider,
    tenantName: resolvedTenantName ?? args.candidateTenantName
  };
}

async function handleSetupRunSimple(
  ctx: CliContext,
  options: {
    tenant?: string;
    name?: string;
    provider?: string;
    key?: string;
    keyFile?: string;
    keyStdin?: boolean;
    setActive?: boolean;
    connectivity?: string;
    nonInteractive?: boolean;
    output?: string;
    format?: OutputFormat;
  }
): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  const explicitTenantName = typeof options.name === 'string' && options.name.trim().length > 0;
  const connectivityMode = parseSetupConnectivityMode(options.connectivity);
  const output = resolveTextJsonOutput({
    output: options.output,
    format: options.format,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });

  let tenantLabel =
    (options.name ?? options.tenant ?? settings.values.defaults.tenant ?? SIMPLE_SETUP_DEFAULT_TENANT).trim() ||
    SIMPLE_SETUP_DEFAULT_TENANT;
  const keyValue = await resolveKeyValue({
    key: options.key,
    keyFile: options.keyFile,
    keyStdin: options.keyStdin,
    envKey: ctx.env.XYTE_CLI_KEY,
    allowPrompt: !options.nonInteractive,
    prompt: ctx.prompt,
    readStdin: ctx.readStdin,
    promptQuestion: 'XYTE API key',
    stdout: ctx.stdout
  });

  if (!options.nonInteractive) {
    tenantLabel =
      (await ctx.prompt({
        question: 'Tenant label (optional)',
        initial: tenantLabel,
        stdout: ctx.stdout
      })) || tenantLabel;
  }

  if (!keyValue) {
    throw new CliUserError({
      summary: 'Missing API key.',
      detail: 'Setup needs --key, --key-file, --key-stdin, XYTE_CLI_KEY, or interactive input.',
      suggestedCommands: ['Use xyte-cli setup run --tenant <tenant-id>']
    });
  }

  const tenantId = normalizeTenantId(options.tenant?.trim() || tenantLabel);
  const { provider, tenantName } = await fetchProviderAndTenantName(ctx, {
    tenantId,
    candidateTenantName: tenantLabel.trim() || tenantId,
    keyValue,
    provider: options.provider ? parseProvider(options.provider) : undefined,
    connectivityMode,
    explicitTenantName
  });
  const setupResult = await runSimpleSetup(ctx, {
    tenantId,
    tenantName,
    keyValue,
    provider,
    setActive: options.setActive !== false,
    connectivityMode
  });

  if (output === 'text') {
    ctx.stdout.write(formatReadinessText(setupResult.readiness));
    return;
  }

  printJson(ctx.stdout, setupResult, { strictJson: resolveStrictJson({ settings }) });
}

async function handleSetupRunAdvanced(
  ctx: CliContext,
  options: {
    tenant?: string;
    name?: string;
    provider?: string;
    slotName?: string;
    key?: string;
    keyFile?: string;
    keyStdin?: boolean;
    setActive?: boolean;
    connectivity?: string;
    nonInteractive?: boolean;
    output?: string;
    format?: OutputFormat;
  }
): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  const explicitTenantName = typeof options.name === 'string' && options.name.trim().length > 0;
  const connectivityMode = parseSetupConnectivityMode(options.connectivity);
  const output = resolveTextJsonOutput({
    output: options.output,
    format: options.format,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });

  const rawTenantId = options.tenant ?? settings.values.defaults.tenant;
  const rawProvider = options.provider ? parseProvider(options.provider) : undefined;
  const rawSlotName = options.slotName ?? 'primary';
  const keyValue = await resolveKeyValue({
    key: options.key,
    keyFile: options.keyFile,
    keyStdin: options.keyStdin,
    envKey: ctx.env.XYTE_CLI_KEY,
    allowPrompt: !options.nonInteractive,
    prompt: ctx.prompt,
    readStdin: ctx.readStdin,
    promptQuestion: 'API key',
    stdout: ctx.stdout
  });

  const tenantId = options.nonInteractive
    ? rawTenantId
    : rawTenantId || (await ctx.prompt({ question: 'Tenant id', stdout: ctx.stdout }));
  const promptedTenantName = options.nonInteractive
    ? options.name
    : options.name ||
      (await ctx.prompt({ question: 'Tenant display name', initial: tenantId, stdout: ctx.stdout }));
  const provider = options.nonInteractive
    ? rawProvider
    : rawProvider ||
      parseProvider(await ctx.prompt({ question: 'Provider', initial: PROVIDER_ORG, stdout: ctx.stdout }));
  const slotName = options.nonInteractive
    ? rawSlotName
    : await ctx.prompt({ question: 'Slot name', initial: rawSlotName, stdout: ctx.stdout });

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
      detail: 'Setup needs --key, --key-file, --key-stdin, XYTE_CLI_KEY, or interactive input.',
      suggestedCommands: ['Use xyte-cli setup run --advanced --tenant <tenant-id> --provider xyte-org']
    });
  }

  const { provider: resolvedProvider, tenantName } = await fetchProviderAndTenantName(ctx, {
    tenantId,
    candidateTenantName: (promptedTenantName?.trim() || tenantId).trim() || tenantId,
    keyValue,
    provider,
    connectivityMode,
    explicitTenantName
  });

  const result = await runSetupCore(ctx, {
    tenantId,
    tenantName,
    provider: resolvedProvider,
    slotName,
    keyValue,
    setActive: options.setActive !== false,
    connectivityMode
  });

  if (output === 'text') {
    ctx.stdout.write(formatReadinessText(result.readiness));
    return;
  }

  printJson(ctx.stdout, result, { strictJson: resolveStrictJson({ settings }) });
}

async function handleSetupRun(
  ctx: CliContext,
  options: {
    tenant?: string;
    name?: string;
    advanced?: boolean;
    provider?: string;
    slotName?: string;
    key?: string;
    keyFile?: string;
    keyStdin?: boolean;
    setActive?: boolean;
    connectivity?: string;
    nonInteractive?: boolean;
    output?: string;
    format?: OutputFormat;
  }
): Promise<void> {
  if (!options.nonInteractive && !ctx.isInteractive) {
    throw new CliUserError({
      summary: 'Interactive setup requires a TTY.',
      suggestedCommands: ['Use xyte-cli setup run --non-interactive --tenant <tenant-id> --key-stdin']
    });
  }

  const advanced = options.advanced === true || options.provider !== undefined;
  if (advanced) {
    await handleSetupRunAdvanced(ctx, options);
  } else {
    await handleSetupRunSimple(ctx, options);
  }
}

export function registerSetupCommands(parent: Command, ctx: CliContext): void {
  const setup = parent.command('setup').description('Run setup and readiness checks');

  setup
    .command('status')
    .description('Show setup/readiness status')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--field <name>', 'Print a single scalar field (for example tenantId)')
    .option('--format <format>', 'json|text', 'json')
    .action(async (options: { tenant?: string; field?: string; format?: OutputFormat }, command: Command) => {
      await handleSetupStatus(ctx, {
        tenant: options.tenant,
        field: options.field,
        format: options.format,
        output: getExplicitGlobalOutput(command)
      });
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
    .option('--key-file <path>', 'Read API key value from a file')
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
          keyFile?: string;
          keyStdin?: boolean;
          setActive?: boolean;
          connectivity?: string;
          nonInteractive?: boolean;
          format?: OutputFormat;
        },
        command: Command
      ) => {
        await handleSetupRun(ctx, { ...options, output: getExplicitGlobalOutput(command) });
      }
    );
}
