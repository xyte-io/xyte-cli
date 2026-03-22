import type { Command } from 'commander';

import { createXyteClient } from '../../client/create-client';
import { evaluateReadiness, type ReadinessCheck } from '../../config/readiness';
import { makeKeyFingerprint } from '../../secure/key-slots';
import type { ApiKeySlotMeta, SecretProvider } from '../../types/profile';
import { parseProvider, PROVIDER_ORG } from '../../types/profile';
import { isRecord } from '../../utils/json';
import { firstText } from '../../workflows/fleet-insights-loaders';
import { CliUserError } from '../../contracts/user-error';
import { formatReadinessText } from '../format-readiness';
import { resolveKeyValue } from '../resolve-key';
import {
  type CliContext,
  type OutputFormat,
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

const SIMPLE_SETUP_AUTH_PROVIDER = PROVIDER_ORG;
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
      cause: `Field "${field}" is missing or not a scalar value.`,
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

export {
  SIMPLE_SETUP_DEFAULT_TENANT,
  normalizeTenantId,
  runSimpleSetup
};

async function resolveTenantNameFromKey(ctx: CliContext, args: {
  tenantId: string;
  provider: SecretProvider;
  keyValue: string;
}): Promise<string | undefined> {
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

async function runSimpleSetup(ctx: CliContext, args: {
  tenantId: string;
  tenantName: string;
  keyValue: string;
  setActive?: boolean;
  connectivityMode?: SetupConnectivityMode;
}): Promise<SetupRunResult> {
  const steps: SetupStep[] = [];
  await ctx.profileStore.upsertTenant({
    id: args.tenantId,
    name: args.tenantName
  });
  steps.push({
    key: 'tenant_upserted',
    status: 'ok',
    detail: args.tenantId
  });
  await ctx.profileStore.setActiveTenant(args.tenantId);
  steps.push({
    key: 'tenant_activated',
    status: 'ok',
    detail: args.tenantId
  });

  const secretStore = ctx.getSecretStore();
  const slots = await ctx.profileStore.listKeySlots(args.tenantId, SIMPLE_SETUP_AUTH_PROVIDER);
  const existing = slots.find((slot) => slot.name.toLowerCase() === SIMPLE_SETUP_SLOT_NAME);

  const slot = existing
    ? await ctx.profileStore.updateKeySlot(args.tenantId, SIMPLE_SETUP_AUTH_PROVIDER, existing.slotId, {
        fingerprint: makeKeyFingerprint(args.keyValue)
      })
    : await ctx.profileStore.addKeySlot(args.tenantId, {
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
    await ctx.profileStore.setActiveKeySlot(args.tenantId, SIMPLE_SETUP_AUTH_PROVIDER, slot.slotId);
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
}

async function handleSetupStatus(ctx: CliContext, options: {
  tenant?: string;
  output?: string;
  format?: OutputFormat;
  field?: string;
}): Promise<void> {
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

async function handleSetupRunSimple(ctx: CliContext, options: {
  tenant?: string;
  name?: string;
  key?: string;
  keyStdin?: boolean;
  setActive?: boolean;
  connectivity?: string;
  nonInteractive?: boolean;
  output?: string;
  format?: OutputFormat;
}): Promise<void> {
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
      cause: 'Setup needs --key, --key-stdin, XYTE_CLI_KEY, or interactive input.',
      suggestedCommands: ['Use xyte-cli setup run --tenant <tenant-id>']
    });
  }

  const tenantId = normalizeTenantId(options.tenant?.trim() || tenantLabel);
  const tenantName = tenantLabel.trim() || tenantId;
  const resolvedTenantName =
    connectivityMode !== 'never' && !explicitTenantName && tenantName === tenantId
      ? await resolveTenantNameFromKey(ctx, {
          tenantId,
          provider: SIMPLE_SETUP_AUTH_PROVIDER,
          keyValue
        })
      : undefined;
  const setupResult = await runSimpleSetup(ctx, {
    tenantId,
    tenantName: resolvedTenantName ?? tenantName,
    keyValue,
    setActive: options.setActive !== false,
    connectivityMode
  });

  if (output === 'text') {
    ctx.stdout.write(formatReadinessText(setupResult.readiness));
    return;
  }

  printJson(ctx.stdout, setupResult, { strictJson: resolveStrictJson({ settings }) });
}

async function handleSetupRunAdvanced(ctx: CliContext, options: {
  tenant?: string;
  name?: string;
  provider?: string;
  slotName?: string;
  key?: string;
  keyStdin?: boolean;
  setActive?: boolean;
  connectivity?: string;
  nonInteractive?: boolean;
  output?: string;
  format?: OutputFormat;
}): Promise<void> {
  const settings = await ctx.resolveSettings(options.tenant ? { 'defaults.tenant': options.tenant } : {});
  const explicitTenantName = typeof options.name === 'string' && options.name.trim().length > 0;
  const connectivityMode = parseSetupConnectivityMode(options.connectivity);
  const output = resolveTextJsonOutput({
    output: options.output,
    format: options.format,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });

  let tenantId = options.tenant ?? settings.values.defaults.tenant;
  let tenantName = options.name;
  let provider = options.provider ? parseProvider(options.provider) : undefined;
  let slotName = options.slotName ?? 'primary';
  const keyValue = await resolveKeyValue({
    key: options.key,
    keyStdin: options.keyStdin,
    envKey: ctx.env.XYTE_CLI_KEY,
    allowPrompt: !options.nonInteractive,
    prompt: ctx.prompt,
    readStdin: ctx.readStdin,
    promptQuestion: 'API key',
    stdout: ctx.stdout
  });
  const steps: SetupStep[] = [];

  if (!options.nonInteractive) {
    tenantId = tenantId || (await ctx.prompt({ question: 'Tenant id', stdout: ctx.stdout }));
    tenantName = tenantName || (await ctx.prompt({ question: 'Tenant display name', initial: tenantId, stdout: ctx.stdout }));
    const providerAnswer = provider || parseProvider(await ctx.prompt({ question: 'Provider', initial: PROVIDER_ORG, stdout: ctx.stdout }));
    provider = providerAnswer;
    slotName = await ctx.prompt({ question: 'Slot name', initial: slotName, stdout: ctx.stdout });
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
      ? await resolveTenantNameFromKey(ctx, {
          tenantId,
          provider,
          keyValue
        })
      : undefined;
  tenantName = resolvedTenantName ?? candidateTenantName;

  await ctx.profileStore.upsertTenant({
    id: tenantId,
    name: tenantName
  });
  steps.push({
    key: 'tenant_upserted',
    status: 'ok',
    detail: tenantId
  });
  await ctx.profileStore.setActiveTenant(tenantId);
  steps.push({
    key: 'tenant_activated',
    status: 'ok',
    detail: tenantId
  });
  const secretStore = ctx.getSecretStore();

  let slot;
  try {
    slot = await ctx.profileStore.addKeySlot(tenantId, {
      provider,
      name: slotName,
      fingerprint: makeKeyFingerprint(keyValue)
    });
  } catch (error) {
    const knownSlots = await ctx.profileStore.listKeySlots(tenantId, provider);
    const existing = knownSlots.find((item) => item.name.toLowerCase() === slotName.toLowerCase());
    if (!existing) {
      throw error;
    }
    slot = await ctx.profileStore.updateKeySlot(tenantId, provider, existing.slotId, {
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
    await ctx.profileStore.setActiveKeySlot(tenantId, provider, slot.slotId);
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
  const client = checkConnectivity ? await ctx.withClient({ tenantId }) : undefined;
  const readiness = await evaluateReadiness({
    profileStore: ctx.profileStore,
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
    ctx.stdout.write(formatReadinessText(readiness));
    return;
  }

  printJson(
    ctx.stdout,
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
}

async function handleSetupRun(ctx: CliContext, options: {
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
}): Promise<void> {
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
      const globals = command.optsWithGlobals() as { output?: string };
      await handleSetupStatus(ctx, { tenant: options.tenant, field: options.field, format: options.format, output: globals.output });
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
        await handleSetupRun(ctx, { ...options, output: globals.output });
      }
    );
}
