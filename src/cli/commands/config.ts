import path from 'node:path';

import type { Command } from 'commander';

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
import { describeSecretStore } from '../../secure/secret-store';
import type { ProfileStore, SecretStore } from '../../types/stores';
import { SUPPORTED_SECRET_PROVIDERS, type SecretProvider } from '../../types/profile';
import { parseProvider } from '../../utils/parse-domain';
import { formatReadinessText } from '../format-readiness';
import { parsePositiveIntegerOption } from '../parse-options';
import { runSlotConnectivityTest } from '../../client/probe';
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

function parseWritableScope(raw: string | undefined): Exclude<CliSettingsScope, 'resolved'> {
  const scope = (raw ?? 'user').trim().toLowerCase();
  if (scope !== 'user' && scope !== 'workspace') {
    throw new CliUserError({
      summary: 'Invalid config scope.',
      detail: `Received "${raw}".`,
      suggestedCommands: ['Use --scope user', 'Use --scope workspace']
    });
  }
  return scope;
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

async function fetchSlotByRef(
  profileStore: ProfileStore,
  tenantId: string,
  provider: SecretProvider,
  slotRef: string
) {
  const slots = await profileStore.listKeySlots(tenantId, provider);
  const slot = slots.find((item) => matchesSlotRef(item, slotRef));
  if (!slot) {
    throw new CliUserError({ summary: `Unknown slot "${slotRef}" for provider ${provider} in tenant ${tenantId}.` });
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
        const explicitOutput = getExplicitGlobalOutput(command);
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
        const client = await ctx.withClient({ tenantId, flagOverrides: overrides });
        const readiness = await evaluateReadiness({
          profileStore: ctx.profileStore,
          secretStore,
          tenantId,
          client,
          checkConnectivity: true
        });

        if (
          resolveTextJsonOutput({
            output: options.format ?? explicitOutput,
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
      const explicitOutput = getExplicitGlobalOutput(command);
      const scope = (options.scope ?? 'resolved').trim().toLowerCase();
      if (!['user', 'workspace', 'resolved'].includes(scope)) {
        throw new CliUserError({
          summary: 'Invalid config scope.',
          detail: `Received "${options.scope}".`,
          suggestedCommands: ['Use --scope resolved', 'Use --scope user', 'Use --scope workspace']
        });
      }
      const settings = await ctx.resolveSettings();
      const output = resolveTextJsonOutput({
        output: options.format ?? explicitOutput,
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
      const explicitOutput = getExplicitGlobalOutput(command);
      const settings = await ctx.resolveSettings();
      const secretStore = await describeSecretStore({
        cwd: ctx.cwd,
        env: ctx.env,
        settings,
        stderr: ctx.stderr
      });
      const output = resolveTextJsonOutput({
        output: options.format ?? explicitOutput,
        stdoutIsTTY: ctx.stdoutIsTTY,
        settings
      });
      const payload = {
        schemaVersion: 'xyte.settings.v1',
        configDir: settings.paths.configDir,
        user: settings.paths.user,
        workspace: settings.paths.workspace,
        secretStoreBackend: secretStore.backend,
        secretStore: secretStore.secretStore,
        legacySecretStore: secretStore.legacySecretStore,
        profile: path.join(settings.paths.configDir, 'profile.json')
      };

      if (output === 'text') {
        ctx.stdout.write(
          `configDir: ${payload.configDir}\nuser: ${payload.user}\nworkspace: ${payload.workspace}\nprofile: ${payload.profile}\nsecretStoreBackend: ${payload.secretStoreBackend}\nsecretStore: ${payload.secretStore}\nlegacySecretStore: ${payload.legacySecretStore}\n`
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
    .action(
      async (key: string, value: string, options: { scope?: string; format?: OutputFormat }, command: Command) => {
        const explicitOutput = getExplicitGlobalOutput(command);
        if (!SUPPORTED_SETTING_KEYS.includes(key as SettingKey)) {
          throw new CliUserError({
            summary: 'Unknown config key.',
            detail: `Received "${key}".`,
            suggestedCommands: [`Supported keys: ${SUPPORTED_SETTING_KEYS.join(', ')}`]
          });
        }
        const targetScope = parseWritableScope(options.scope);
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
          output: options.format ?? explicitOutput,
          stdoutIsTTY: ctx.stdoutIsTTY,
          settings
        });
        const payload = {
          schemaVersion: 'xyte.settings.v1',
          scope: targetScope,
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
      }
    );

  config
    .command('unset')
    .description('Unset a layered config value')
    .argument('<key>', 'Config key')
    .option('--scope <scope>', 'user|workspace', 'user')
    .option('--format <format>', 'json|text')
    .action(async (key: string, options: { scope?: string; format?: OutputFormat }, command: Command) => {
      const explicitOutput = getExplicitGlobalOutput(command);
      if (!SUPPORTED_SETTING_KEYS.includes(key as SettingKey)) {
        throw new CliUserError({
          summary: 'Unknown config key.',
          detail: `Received "${key}".`,
          suggestedCommands: [`Supported keys: ${SUPPORTED_SETTING_KEYS.join(', ')}`]
        });
      }
      const targetScope = parseWritableScope(options.scope);
      const result = unsetCliSettingSync({
        scope: targetScope,
        key: key as SettingKey,
        cwd: ctx.cwd,
        env: ctx.env
      });
      const settings = await ctx.resolveSettings();
      const output = resolveTextJsonOutput({
        output: options.format ?? explicitOutput,
        stdoutIsTTY: ctx.stdoutIsTTY,
        settings
      });
      const payload = {
        schemaVersion: 'xyte.settings.v1',
        scope: targetScope,
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

  configTenant.command('list').action(async () => {
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
    .option('--provider <provider>', SUPPORTED_SECRET_PROVIDERS.join('|'))
    .requiredOption('--name <name>', 'Slot display name')
    .option('--slot-id <slotId>', 'Optional explicit slot id')
    .option('--key <value>', 'API key value')
    .option('--key-file <path>', 'Read API key value from a file')
    .option('--key-stdin', 'Read API key value from stdin')
    .option('--set-active', 'Set as active slot for provider')
    .action(
      async (options: {
        tenant: string;
        provider?: string;
        name: string;
        slotId?: string;
        key?: string;
        keyFile?: string;
        keyStdin?: boolean;
        setActive?: boolean;
      }) => {
        const value = await resolveKeyValue({
          key: options.key,
          keyFile: options.keyFile,
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
            detail: 'Use --key, --key-file, --key-stdin, or XYTE_CLI_KEY.',
            suggestedCommands: ['Use xyte-cli config key add --tenant <tenant-id> --provider xyte-org --name primary']
          });
        }
        const provider = await fetchProviderForKey({
          profileStore: ctx.profileStore,
          tenantId: options.tenant,
          keyValue: value,
          provider: options.provider ? parseProvider(options.provider) : undefined,
          allowProbe: true
        });
        const existingTenant = await ctx.profileStore.getTenant(options.tenant);
        await ctx.profileStore.upsertTenant({
          id: options.tenant,
          apiProvider: existingTenant?.apiProvider ?? provider
        });
        const secretStore = ctx.getSecretStore();
        const slot = await ctx.profileStore.addKeySlot(options.tenant, provider, {
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
      const explicitOutput = getExplicitGlobalOutput(command);
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
          output: options.format ?? explicitOutput,
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
    .option('--key-file <path>', 'Read API key value from a file')
    .option('--key-stdin', 'Read API key value from stdin')
    .action(
      async (options: {
        tenant: string;
        provider: string;
        slot: string;
        key?: string;
        keyFile?: string;
        keyStdin?: boolean;
      }) => {
        const provider = parseProvider(options.provider);
        const slot = await fetchSlotByRef(ctx.profileStore, options.tenant, provider, options.slot);
        const value = await resolveKeyValue({
          key: options.key,
          keyFile: options.keyFile,
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
            detail: 'Use --key, --key-file, --key-stdin, or XYTE_CLI_KEY.',
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
      const slot = await fetchSlotByRef(ctx.profileStore, options.tenant, provider, options.slot);
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
      const slot = await fetchSlotByRef(ctx.profileStore, options.tenant, provider, options.slot);
      const secretStore = ctx.getSecretStore();
      const secret = await secretStore.getSlotSecret(options.tenant, provider, slot.slotId);
      if (!secret) {
        throw new CliUserError({
          summary: 'No secret found for selected key slot.',
          detail: `Slot "${slot.slotId}" has no stored secret.`,
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
