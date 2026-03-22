import path from 'node:path';

import type { Command } from 'commander';

import { createXyteClient } from '../../client/create-client';
import { evaluateReadiness } from '../../config/readiness';
import {
  SUPPORTED_SETTING_KEYS,
  parseSettingValue,
  setCliSettingSync,
  unsetCliSettingSync,
  type CliSettingsScope,
  type SettingKey
} from '../../config/settings';
import { CliUserError } from '../../contracts/user-error';
import { makeKeyFingerprint, matchesSlotRef } from '../../secure/key-slots';
import type { ProfileStore } from '../../secure/profile-store';
import type { SecretStore } from '../../secure/secret-store';
import { PROVIDER_ORG, PROVIDER_PARTNER, SUPPORTED_SECRET_PROVIDERS, parseProvider, type SecretProvider } from '../../types/profile';
import {
  type CliContext,
  type OutputFormat,
  createSecretConflictError,
  formatReadinessText,
  resolveKeyValue,
  parsePositiveIntegerOption,
  printJson,
  resolveStrictJson,
  resolveTextJsonOutput
} from '../cli-context';

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

async function runSlotConnectivityTest(args: {
  provider: SecretProvider;
  tenantId: string;
  key: string;
  profileStore: ProfileStore;
}) {
  if (args.provider === PROVIDER_ORG) {
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

  if (args.provider === PROVIDER_PARTNER) {
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

  const _exhaustive: never = args.provider;
  throw new Error(`Unhandled provider: ${_exhaustive}`);
}

export function registerConfigCommands(parent: Command, ctx: CliContext): void {
  const config = parent.command('config').description('Configuration and diagnostics');

  config
    .command('doctor')
    .description('Run connectivity and readiness diagnostics')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--retry-attempts <n>', 'Retry attempts for HTTP transport', '2')
    .option('--retry-backoff-ms <n>', 'Retry backoff (ms) for HTTP transport', '250')
    .option('--format <format>', 'json|text', 'json')
    .action(
      async (
        options: { tenant?: string; retryAttempts?: string; retryBackoffMs?: string; format?: OutputFormat },
        command: Command
      ) => {
        const globals = command.optsWithGlobals() as { output?: string };
        const overrides: Partial<Record<SettingKey, unknown>> = {};
        if (options.tenant) {
          overrides['defaults.tenant'] = options.tenant;
        }
        if (options.retryAttempts) {
          overrides['http.retryAttempts'] = parsePositiveIntegerOption(options.retryAttempts, 2, 'retry-attempts');
        }
        if (options.retryBackoffMs) {
          overrides['http.retryBackoffMs'] = parsePositiveIntegerOption(
            options.retryBackoffMs,
            250,
            'retry-backoff-ms'
          );
        }
        const settings = await ctx.resolveSettings(overrides);
        const tenantId = options.tenant ?? settings.values.defaults.tenant;
        const secretStore = ctx.getSecretStore();
        const client = await ctx.withClient(tenantId, undefined, overrides);
        const readiness = await evaluateReadiness({
          profileStore: ctx.profileStore,
          secretStore,
          tenantId,
          client,
          checkConnectivity: true
        });

        if (
          resolveTextJsonOutput({
            output: globals.output,
            format: options.format,
            stdoutIsTTY: ctx.stdoutIsTTY,
            settings
          }) === 'text'
        ) {
          ctx.stdout.write(formatReadinessText(readiness));
          return;
        }

        printJson(
          ctx.stdout,
          {
            retryAttempts: settings.values.http.retryAttempts,
            retryBackoffMs: settings.values.http.retryBackoffMs,
            readiness
          },
          { strictJson: resolveStrictJson({ settings }) }
        );
      }
    );

  config
    .command('show')
    .description('Show user, workspace, or resolved settings')
    .option('--scope <scope>', 'user|workspace|resolved', 'resolved')
    .option('--format <format>', 'json|text')
    .action(async (options: { scope?: string; format?: OutputFormat }, command: Command) => {
      const globals = command.optsWithGlobals() as { output?: string };
      const scope = (options.scope ?? 'resolved').trim().toLowerCase();
      if (!['user', 'workspace', 'resolved'].includes(scope)) {
        throw new CliUserError({
          summary: 'Invalid config scope.',
          cause: `Received "${options.scope}".`,
          suggestedCommands: ['Use --scope resolved', 'Use --scope user', 'Use --scope workspace']
        });
      }
      const settings = await ctx.resolveSettings();
      const output = resolveTextJsonOutput({
        output: globals.output,
        format: options.format,
        stdoutIsTTY: ctx.stdoutIsTTY,
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
        ctx.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
      }
      printJson(ctx.stdout, payload, { strictJson: resolveStrictJson({ settings }) });
    });

  config
    .command('path')
    .description('Show settings, profile, and secret-store paths')
    .option('--format <format>', 'json|text')
    .action(async (options: { format?: OutputFormat }, command: Command) => {
      const globals = command.optsWithGlobals() as { output?: string };
      const settings = await ctx.resolveSettings();
      const output = resolveTextJsonOutput({
        output: globals.output,
        format: options.format,
        stdoutIsTTY: ctx.stdoutIsTTY,
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
        ctx.stdout.write(
          `configDir: ${payload.configDir}\nuser: ${payload.user}\nworkspace: ${payload.workspace}\nprofile: ${payload.profile}\nsecretStore: ${payload.secretStore}\n`
        );
        return;
      }
      printJson(ctx.stdout, payload, { strictJson: resolveStrictJson({ settings }) });
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
      const targetScope = scope as Exclude<CliSettingsScope, 'resolved'>;
      const parsedValue = parseSettingValue(key as SettingKey, value);
      const result = setCliSettingSync({
        scope: targetScope,
        key: key as SettingKey,
        value: parsedValue,
        cwd: ctx.cwd,
        env: ctx.env
      });
      const settings = await ctx.resolveSettings();
      const output = resolveTextJsonOutput({
        output: globals.output,
        format: options.format,
        stdoutIsTTY: ctx.stdoutIsTTY,
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
        ctx.stdout.write(`Set ${key}=${JSON.stringify(parsedValue)} in ${result.path}\n`);
        return;
      }
      printJson(ctx.stdout, payload, { strictJson: resolveStrictJson({ settings }) });
    });

  config
    .command('unset')
    .description('Unset a layered config value')
    .argument('<key>', 'Config key')
    .option('--scope <scope>', 'user|workspace', 'user')
    .option('--format <format>', 'json|text')
    .action(async (key: string, options: { scope?: string; format?: OutputFormat }, command: Command) => {
      const globals = command.optsWithGlobals() as { output?: string };
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
      const targetScope = scope as Exclude<CliSettingsScope, 'resolved'>;
      const result = unsetCliSettingSync({
        scope: targetScope,
        key: key as SettingKey,
        cwd: ctx.cwd,
        env: ctx.env
      });
      const settings = await ctx.resolveSettings();
      const output = resolveTextJsonOutput({
        output: globals.output,
        format: options.format,
        stdoutIsTTY: ctx.stdoutIsTTY,
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
        ctx.stdout.write(`Unset ${key} in ${result.path}\n`);
        return;
      }
      printJson(ctx.stdout, payload, { strictJson: resolveStrictJson({ settings }) });
    });

  const configTenant = config.command('tenant').description('Manage tenant profiles');
  configTenant
    .command('add')
    .argument('<tenantId>', 'Tenant id')
    .option('--name <name>', 'Display name')
    .option('--hub-url <url>', 'Hub API base URL')
    .option('--entry-url <url>', 'Entry API base URL')
    .action(async (tenantId: string, options: Record<string, string | undefined>) => {
      const tenantProfile = await ctx.profileStore.upsertTenant({
        id: tenantId,
        name: options.name,
        hubBaseUrl: options.hubUrl,
        entryBaseUrl: options.entryUrl
      });
      printJson(ctx.stdout, tenantProfile);
    });

  configTenant
    .command('list')
    .action(async () => {
      const data = await ctx.profileStore.getData();
      printJson(ctx.stdout, {
        activeTenantId: data.activeTenantId,
        tenants: data.tenants
      });
    });

  configTenant
    .command('use')
    .argument('<tenantId>', 'Tenant id to set active')
    .action(async (tenantId: string) => {
      await ctx.profileStore.setActiveTenant(tenantId);
      ctx.stdout.write(`Active tenant set to ${tenantId}\n`);
    });

  configTenant
    .command('remove')
    .argument('<tenantId>', 'Tenant id')
    .action(async (tenantId: string) => {
      await ctx.profileStore.removeTenant(tenantId);
      ctx.stdout.write(`Removed tenant ${tenantId}\n`);
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
    .action(
      async (options: {
        tenant: string;
        provider: string;
        name: string;
        slotId?: string;
        key?: string;
        keyStdin?: boolean;
        setActive?: boolean;
      }) => {
        const provider = parseProvider(options.provider);
        const value = await resolveKeyValue({
          key: options.key,
          keyStdin: options.keyStdin,
          envKey: ctx.env.XYTE_CLI_KEY,
          prompt: ctx.prompt,
          readStdin: ctx.readStdin,
          promptQuestion: 'API key',
          stdout: ctx.stdout
        });
        if (!value) {
          throw new CliUserError({
            summary: 'Missing key value.',
            cause: 'Use --key, --key-stdin, or XYTE_CLI_KEY.',
            suggestedCommands: [
              'Use xyte-cli config key add --tenant <tenant-id> --provider xyte-org --name primary'
            ]
          });
        }
        await ctx.profileStore.upsertTenant({ id: options.tenant });
        const secretStore = ctx.getSecretStore();
        const slot = await ctx.profileStore.addKeySlot(options.tenant, {
          provider,
          name: options.name,
          slotId: options.slotId,
          fingerprint: makeKeyFingerprint(value)
        });
        await secretStore.setSlotSecret(options.tenant, provider, slot.slotId, value);
        if (options.setActive) {
          await ctx.profileStore.setActiveKeySlot(options.tenant, provider, slot.slotId);
        }
        printJson(ctx.stdout, {
          tenantId: options.tenant,
          provider,
          slot
        });
      }
    );

  configKey
    .command('list')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .option('--provider <provider>', 'Optional provider filter')
    .option('--format <format>', 'json|text', 'json')
    .action(async (options: { tenant: string; provider?: string; format?: OutputFormat }, command: Command) => {
      const globals = command.optsWithGlobals() as { output?: string };
      const settings = await ctx.resolveSettings({ 'defaults.tenant': options.tenant });
      const secretStore = ctx.getSecretStore();
      const provider = options.provider ? parseProvider(options.provider) : undefined;
      const slots = await collectSlotViews({
        profileStore: ctx.profileStore,
        secretStore,
        tenantId: options.tenant,
        provider
      });
      if (
        resolveTextJsonOutput({
          output: globals.output,
          format: options.format,
          stdoutIsTTY: ctx.stdoutIsTTY,
          settings
        }) === 'text'
      ) {
        ctx.stdout.write(formatSlotListText(slots));
        return;
      }
      printJson(ctx.stdout, { tenantId: options.tenant, slots }, { strictJson: resolveStrictJson({ settings }) });
    });

  configKey
    .command('use')
    .requiredOption('--tenant <tenantId>', 'Tenant id')
    .requiredOption('--provider <provider>', 'Provider')
    .requiredOption('--slot <slotRef>', 'Slot id or name')
    .action(async (options: { tenant: string; provider: string; slot: string }) => {
      const provider = parseProvider(options.provider);
      const slot = await ctx.profileStore.setActiveKeySlot(options.tenant, provider, options.slot);
      printJson(ctx.stdout, {
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
      const updated = await ctx.profileStore.updateKeySlot(options.tenant, provider, options.slot, {
        name: options.name
      });
      printJson(ctx.stdout, {
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
    .action(
      async (options: { tenant: string; provider: string; slot: string; key?: string; keyStdin?: boolean }) => {
        const provider = parseProvider(options.provider);
        const slot = await resolveSlotByRef(ctx.profileStore, options.tenant, provider, options.slot);
        const value = await resolveKeyValue({
          key: options.key,
          keyStdin: options.keyStdin,
          envKey: ctx.env.XYTE_CLI_KEY,
          prompt: ctx.prompt,
          readStdin: ctx.readStdin,
          promptQuestion: 'API key',
          stdout: ctx.stdout
        });
        if (!value) {
          throw new CliUserError({
            summary: 'Missing key value.',
            cause: 'Use --key, --key-stdin, or XYTE_CLI_KEY.',
            suggestedCommands: [
              'Use xyte-cli config key update --tenant <tenant-id> --provider xyte-org --slot <slot-id>'
            ]
          });
        }
        const secretStore = ctx.getSecretStore();
        await secretStore.setSlotSecret(options.tenant, provider, slot.slotId, value);
        const updated = await ctx.profileStore.updateKeySlot(options.tenant, provider, slot.slotId, {
          fingerprint: makeKeyFingerprint(value)
        });
        printJson(ctx.stdout, {
          tenantId: options.tenant,
          provider,
          slot: updated
        });
      }
    );

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
      const slot = await resolveSlotByRef(ctx.profileStore, options.tenant, provider, options.slot);
      const secretStore = ctx.getSecretStore();
      await secretStore.clearSlotSecret(options.tenant, provider, slot.slotId);
      await ctx.profileStore.removeKeySlot(options.tenant, provider, slot.slotId);
      printJson(ctx.stdout, {
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
      const slot = await resolveSlotByRef(ctx.profileStore, options.tenant, provider, options.slot);
      const secretStore = ctx.getSecretStore();
      const secret = await secretStore.getSlotSecret(options.tenant, provider, slot.slotId);
      if (!secret) {
        throw new CliUserError({
          summary: 'No secret found for selected key slot.',
          cause: `Slot "${slot.slotId}" has no stored secret.`,
          suggestedCommands: [
            `xyte-cli config key update --tenant ${options.tenant} --provider ${provider} --slot ${slot.slotId}`
          ]
        });
      }
      const probe = await runSlotConnectivityTest({
        provider,
        tenantId: options.tenant,
        key: secret,
        profileStore: ctx.profileStore
      });
      const validatedAt = new Date().toISOString();
      const updated = await ctx.profileStore.updateKeySlot(options.tenant, provider, slot.slotId, {
        lastValidatedAt: validatedAt
      });
      printJson(ctx.stdout, {
        tenantId: options.tenant,
        provider,
        slot: updated,
        probe
      });
    });
}
