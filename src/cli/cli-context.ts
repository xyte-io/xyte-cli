import type { Command } from 'commander';

import type { ProfileStore } from '../secure/profile-store';
import type { SecretStore } from '../secure/secret-store';
import type { XyteClient } from '../types/client';
import type { CliOutputMode, ResolvedCliSettingsState, SettingKey } from '../config/settings';
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
  withClient: (args?: {
    tenantId?: string;
    retry?: { attempts?: number; backoffMs?: number };
    flagOverrides?: Partial<Record<SettingKey, unknown>>;
  }) => Promise<XyteClient>;
}

export interface CliGlobalOptions {
  output?: string;
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

export function printJson(
  stream: OutputStream,
  value: unknown,
  options: { strictJson?: boolean; compact?: boolean } = {}
): void {
  stream.write(`${stringifyJsonOutput(value, options)}\n`);
}

