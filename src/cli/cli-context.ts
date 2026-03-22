import type { Command } from 'commander';

import type { ProfileStore } from '../secure/profile-store';
import type { SecretStore } from '../secure/secret-store';
import type { XyteClient } from '../types/client';
import type { CliOutputMode, ResolvedCliSettingsState, SettingKey } from '../config/settings';
import type { ReadinessCheck } from '../config/readiness';
import { stringifyJsonOutput } from '../utils/json-output';
import { CliUserError } from '../contracts/user-error';

export type OutputStream = Pick<typeof process.stdout, 'write'>;
export type ErrorStream = Pick<typeof process.stderr, 'write'>;
export type OutputFormat = 'json' | 'text';
export type PromptValueFn = (args: {
  question: string;
  initial?: string;
  stdout: OutputStream;
  secret?: boolean;
}) => Promise<string>;

export interface CliContext {
  stdout: OutputStream;
  stderr: ErrorStream;
  stdoutIsTTY: boolean;
  isInteractive: boolean;
  profileStore: ProfileStore;
  getSecretStore: () => SecretStore;
  cwd: string;
  env: NodeJS.ProcessEnv;
  prompt: PromptValueFn;
  readStdin: () => Promise<string>;
  resolveSettings: (flagOverrides?: Partial<Record<SettingKey, unknown>>) => Promise<ResolvedCliSettingsState>;
  withClient: (
    tenantId?: string,
    retry?: { attempts?: number; backoffMs?: number },
    flagOverrides?: Partial<Record<SettingKey, unknown>>
  ) => Promise<XyteClient>;
}

export function getExplicitGlobalOutput(command: Command): CliOutputMode | undefined {
  const source = command.getOptionValueSourceWithGlobals('output');
  if (!source || source === 'default') {
    return undefined;
  }
  const options = command.optsWithGlobals() as { output?: string };
  return parseCliOutputMode(options.output);
}

export function parseCliOutputMode(value: string | undefined): CliOutputMode | undefined {
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
  return normalized as CliOutputMode;
}

export function resolveTextJsonOutput(args: {
  output?: CliOutputMode | string;
  format?: string;
  stdoutIsTTY: boolean;
  settings: ResolvedCliSettingsState;
}): OutputFormat {
  const explicitOutput = parseCliOutputMode(args.output as string | undefined);
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

export function resolveStrictJson(args: { strictJson?: boolean; settings: ResolvedCliSettingsState }): boolean {
  if (args.strictJson === true) {
    return true;
  }
  return args.settings.values.output.strictJson;
}

export function renderJsonOutput(
  value: unknown,
  options: { strictJson?: boolean; compact?: boolean } = {}
): string {
  return stringifyJsonOutput(value, { strictJson: options.strictJson, compact: options.compact });
}

export function printJson(
  stream: OutputStream,
  value: unknown,
  options: { strictJson?: boolean; compact?: boolean } = {}
): void {
  stream.write(`${renderJsonOutput(value, options)}\n`);
}

export function createSecretConflictError(cause: string): CliUserError {
  return new CliUserError({
    summary: 'Conflicting API key sources.',
    cause,
    suggestedCommands: ['Use exactly one of --key, --key-stdin, or XYTE_CLI_KEY']
  });
}

export async function resolveKeyValue(args: {
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

export function parsePositiveIntegerOption(value: string | undefined, fallback: number, label: string): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: ${value}. Use a positive integer.`);
  }
  return parsed;
}

export function parsePositiveNumberOption(
  value: string | undefined,
  fallback: number | undefined,
  label: string
): number | undefined {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${label}: expected a positive number, got "${value}".`);
  }
  return parsed;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatReadinessText(readiness: ReadinessCheck): string {
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
