import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import path from 'node:path';

import { getXyteConfigDir } from '../utils/config-dir';
import { isRecord } from '../utils/json';
import { INSPECT_PROVIDER_SCOPES, type InspectProviderScope } from '../types/settings-enums';
import { DEFAULT_WATCH_PROFILE, type WatchProfile } from '../contracts/watch-frame';

const CLI_OUTPUT_MODES = ['auto', 'json', 'text'] as const;
export type CliOutputMode = (typeof CLI_OUTPUT_MODES)[number];
export type CliSettingsScope = 'user' | 'workspace' | 'resolved';

interface CliSettingsFile {
  version?: 'settings.v1';
  defaults?: {
    tenant?: string;
  };
  output?: {
    mode?: CliOutputMode;
    strictJson?: boolean;
  };
  ops?: {
    providerScope?: InspectProviderScope;
  };
  watch?: {
    profile?: WatchProfile;
    intervalMs?: number;
    maxPolls?: number;
  };
  http?: {
    retryAttempts?: number;
    retryBackoffMs?: number;
  };
  console?: {
    screen?: string;
    motion?: boolean;
    follow?: boolean;
    intervalMs?: number;
    debugLogPath?: string;
  };
  logs?: {
    enabled?: boolean;
    path?: string;
    verbose?: boolean;
    maxFileBytes?: number;
    maxFiles?: number;
    mirrorToStderr?: boolean;
  };
  report?: {
    includeSensitive?: boolean;
  };
}

interface ResolvedCliSettings {
  defaults: {
    tenant?: string;
  };
  output: {
    mode: CliOutputMode;
    strictJson: boolean;
  };
  ops: {
    providerScope: InspectProviderScope;
  };
  watch: {
    profile: WatchProfile;
    intervalMs: number;
    maxPolls?: number;
  };
  http: {
    retryAttempts: number;
    retryBackoffMs: number;
  };
  console: {
    screen: string;
    motion: boolean;
    follow: boolean;
    intervalMs: number;
    debugLogPath?: string;
  };
  logs: {
    enabled: boolean;
    path?: string;
    verbose: boolean;
    maxFileBytes: number;
    maxFiles: number;
    mirrorToStderr: boolean;
  };
  report: {
    includeSensitive: boolean;
  };
}

export interface ResolvedCliSettingsState {
  paths: {
    configDir: string;
    user: string;
    workspace: string;
  };
  user: CliSettingsFile;
  workspace: CliSettingsFile;
  values: ResolvedCliSettings;
  sources: Record<string, 'default' | 'profile' | 'user' | 'workspace' | 'env' | 'flag'>;
}

const DEFAULT_SETTINGS: ResolvedCliSettings = {
  defaults: {},
  output: {
    mode: 'auto',
    strictJson: false
  },
  ops: {
    providerScope: 'auto'
  },
  watch: {
    profile: DEFAULT_WATCH_PROFILE,
    intervalMs: 2000
  },
  http: {
    retryAttempts: 2,
    retryBackoffMs: 250
  },
  console: {
    screen: 'dashboard',
    motion: true,
    follow: false,
    intervalMs: 2000
  },
  logs: {
    enabled: false,
    verbose: false,
    maxFileBytes: 10 * 1024 * 1024,
    maxFiles: 5,
    mirrorToStderr: false
  },
  report: {
    includeSensitive: false
  }
};

const SETTING_PATHS = [
  'defaults.tenant',
  'output.mode',
  'output.strictJson',
  'ops.providerScope',
  'watch.profile',
  'watch.intervalMs',
  'watch.maxPolls',
  'http.retryAttempts',
  'http.retryBackoffMs',
  'console.screen',
  'console.motion',
  'console.follow',
  'console.intervalMs',
  'console.debugLogPath',
  'logs.enabled',
  'logs.path',
  'logs.verbose',
  'logs.maxFileBytes',
  'logs.maxFiles',
  'logs.mirrorToStderr',
  'report.includeSensitive'
] as const;

type SettingPath = (typeof SETTING_PATHS)[number];
export type SettingKey = SettingPath;

type SourceValue = {
  value: unknown;
  source: 'default' | 'profile' | 'user' | 'workspace' | 'env' | 'flag';
};

function cloneSettings<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readSettingsFile(filePath: string): CliSettingsFile {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    return parsed as CliSettingsFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

function writeSettingsFile(filePath: string, settings: CliSettingsFile): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function getPathValue(record: unknown, keyPath: string): unknown {
  const segments = keyPath.split('.');
  let current = record;
  for (const segment of segments) {
    if (!isRecord(current) || !(segment in current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function setPathValue(record: Record<string, unknown>, keyPath: SettingPath, value: unknown): void {
  const segments = keyPath.split('.');
  let current: Record<string, unknown> = record;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === '__proto__' || segment === 'prototype' || segment === 'constructor') {
      throw new Error(`Blocked config key segment: ${segment}.`);
    }
    if (index === segments.length - 1) {
      current[segment] = value;
      break;
    }

    const next = Object.hasOwn(current, segment) ? current[segment] : undefined;
    if (!isRecord(next)) {
      current[segment] = Object.create(null) as Record<string, unknown>;
    }
    current = current[segment] as Record<string, unknown>;
  }
}

function unsetPathValue(record: Record<string, unknown>, keyPath: SettingPath): void {
  const segments = keyPath.split('.');
  let current: Record<string, unknown> = record;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment === '__proto__' || segment === 'prototype' || segment === 'constructor') {
      throw new Error(`Blocked config key segment: ${segment}.`);
    }
    const next: unknown = current && Object.hasOwn(current, segment) ? current[segment] : undefined;
    if (!isRecord(next)) {
      return;
    }
    current = next;
  }

  const leafSegment = segments.at(-1)!;
  if (leafSegment === '__proto__' || leafSegment === 'prototype' || leafSegment === 'constructor') {
    throw new Error(`Blocked config key segment: ${leafSegment}.`);
  }
  delete current[leafSegment];
}

function parseBoolean(value: unknown, label: string): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  throw new Error(`Invalid ${label}: ${String(value)}. Use true|false.`);
}

function parsePositiveInteger(value: unknown, label: string): number {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  throw new Error(`Invalid ${label}: ${String(value)}. Use a positive integer.`);
}

function parseOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  return parsePositiveInteger(value, label);
}

function parseOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : undefined;
}

function parseEnum<T extends string>(value: unknown, label: string, allowed: readonly T[]): T {
  const normalized = parseOptionalString(value);
  if (normalized && allowed.includes(normalized as T)) {
    return normalized as T;
  }
  throw new Error(`Invalid ${label}: ${String(value)}. Use ${allowed.join('|')}.`);
}

function validateSettingValue(keyPath: SettingPath, value: unknown): unknown {
  switch (keyPath) {
    case 'defaults.tenant':
    case 'console.debugLogPath':
    case 'logs.path':
      return parseOptionalString(value);
    case 'output.mode':
      return parseEnum(value, keyPath, [...CLI_OUTPUT_MODES]);
    case 'output.strictJson':
    case 'console.motion':
    case 'console.follow':
    case 'logs.enabled':
    case 'logs.verbose':
    case 'logs.mirrorToStderr':
    case 'report.includeSensitive':
      return parseBoolean(value, keyPath);
    case 'ops.providerScope':
      return parseEnum(value, keyPath, [...INSPECT_PROVIDER_SCOPES]);
    case 'watch.profile':
      return parseEnum(value, keyPath, [DEFAULT_WATCH_PROFILE]);
    case 'watch.intervalMs':
    case 'http.retryAttempts':
    case 'http.retryBackoffMs':
    case 'console.intervalMs':
    case 'logs.maxFileBytes':
    case 'logs.maxFiles':
      return parsePositiveInteger(value, keyPath);
    case 'watch.maxPolls':
      return parseOptionalPositiveInteger(value, keyPath);
    case 'console.screen':
      return parseOptionalString(value);
    default: {
      const _exhaustive: never = keyPath;
      throw new Error(`Unhandled setting key: ${_exhaustive}`);
    }
  }
}

function getEnvValue(env: NodeJS.ProcessEnv, keyPath: SettingPath): unknown {
  switch (keyPath) {
    case 'defaults.tenant':
      return env.XYTE_CLI_DEFAULT_TENANT;
    case 'output.mode':
      return env.XYTE_CLI_OUTPUT_MODE;
    case 'output.strictJson':
      return env.XYTE_CLI_OUTPUT_STRICT_JSON;
    case 'ops.providerScope':
      return env.XYTE_CLI_OPS_PROVIDER_SCOPE;
    case 'watch.profile':
      return env.XYTE_CLI_WATCH_PROFILE;
    case 'watch.intervalMs':
      return env.XYTE_CLI_WATCH_INTERVAL_MS;
    case 'watch.maxPolls':
      return env.XYTE_CLI_WATCH_MAX_POLLS;
    case 'http.retryAttempts':
      return env.XYTE_CLI_HTTP_RETRY_ATTEMPTS;
    case 'http.retryBackoffMs':
      return env.XYTE_CLI_HTTP_RETRY_BACKOFF_MS;
    case 'console.screen':
      return env.XYTE_CLI_CONSOLE_SCREEN;
    case 'console.motion':
      if (env.XYTE_CLI_CONSOLE_MOTION !== undefined) {
        return env.XYTE_CLI_CONSOLE_MOTION;
      }
      if (env.XYTE_TUI_REDUCED_MOTION !== undefined) {
        return env.XYTE_TUI_REDUCED_MOTION === '1' ? 'false' : 'true';
      }
      return undefined;
    case 'console.follow':
      return env.XYTE_CLI_CONSOLE_FOLLOW;
    case 'console.intervalMs':
      return env.XYTE_CLI_CONSOLE_INTERVAL_MS;
    case 'console.debugLogPath':
      return env.XYTE_CLI_CONSOLE_DEBUG_LOG_PATH ?? env.XYTE_TUI_DEBUG_LOG;
    case 'logs.enabled':
      return env.XYTE_CLI_LOGS_ENABLED ?? env.XYTE_LOG_ACTIONS;
    case 'logs.path':
      return env.XYTE_CLI_LOGS_PATH ?? env.XYTE_LOG_ACTIONS_PATH;
    case 'logs.verbose':
      return env.XYTE_CLI_LOGS_VERBOSE ?? env.XYTE_LOG_ACTIONS_VERBOSE;
    case 'logs.maxFileBytes':
      return env.XYTE_CLI_LOGS_MAX_FILE_BYTES ?? env.XYTE_LOG_ACTIONS_MAX_FILE_BYTES;
    case 'logs.maxFiles':
      return env.XYTE_CLI_LOGS_MAX_FILES ?? env.XYTE_LOG_ACTIONS_MAX_FILES;
    case 'logs.mirrorToStderr':
      return env.XYTE_CLI_LOGS_MIRROR_TO_STDERR ?? env.XYTE_LOG_ACTIONS_STDERR;
    case 'report.includeSensitive':
      return env.XYTE_CLI_REPORT_INCLUDE_SENSITIVE;
    default: {
      const _exhaustive: never = keyPath;
      return undefined;
    }
  }
}

function getSettingsValueSources(args: {
  user: CliSettingsFile;
  workspace: CliSettingsFile;
  env: NodeJS.ProcessEnv;
  activeTenantId?: string;
}): Record<SettingPath, SourceValue> {
  const sources = {} as Record<SettingPath, SourceValue>;
  for (const keyPath of SETTING_PATHS) {
    const envValue = getEnvValue(args.env, keyPath);
    if (envValue !== undefined) {
      sources[keyPath] = {
        value: validateSettingValue(keyPath, envValue),
        source: 'env'
      };
      continue;
    }

    const workspaceValue = getPathValue(args.workspace, keyPath);
    if (workspaceValue !== undefined) {
      sources[keyPath] = {
        value: validateSettingValue(keyPath, workspaceValue),
        source: 'workspace'
      };
      continue;
    }

    const userValue = getPathValue(args.user, keyPath);
    if (userValue !== undefined) {
      sources[keyPath] = {
        value: validateSettingValue(keyPath, userValue),
        source: 'user'
      };
      continue;
    }

    if (keyPath === 'defaults.tenant' && args.activeTenantId) {
      sources[keyPath] = {
        value: args.activeTenantId,
        source: 'profile'
      };
      continue;
    }

    sources[keyPath] = {
      value: getPathValue(DEFAULT_SETTINGS, keyPath),
      source: 'default'
    };
  }
  return sources;
}

function buildResolvedSettings(values: Record<SettingPath, SourceValue>): ResolvedCliSettings {
  const resolved = cloneSettings(DEFAULT_SETTINGS) as unknown as Record<string, unknown>;
  for (const [keyPath, sourceValue] of Object.entries(values) as Array<[SettingPath, SourceValue]>) {
    if (sourceValue.value !== undefined) {
      setPathValue(resolved, keyPath, sourceValue.value);
    }
  }
  return resolved as unknown as ResolvedCliSettings;
}

export const SUPPORTED_SETTING_KEYS = SETTING_PATHS;

function getUserSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getXyteConfigDir(env), 'settings.json');
}

function getWorkspaceSettingsPath(cwd = process.cwd()): string {
  return path.join(cwd, '.xyte', 'config.json');
}

function readCliSettingsFile(
  scope: Exclude<CliSettingsScope, 'resolved'>,
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env
): CliSettingsFile {
  const filePath = scope === 'user' ? getUserSettingsPath(env) : getWorkspaceSettingsPath(cwd);
  return readSettingsFile(filePath);
}

export function resolveCliSettingsSync(
  args: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    activeTenantId?: string;
    flagOverrides?: Partial<Record<SettingPath, unknown>>;
  } = {}
): ResolvedCliSettingsState {
  const cwd = args.cwd ?? process.cwd();
  const env = args.env ?? process.env;
  const userPath = getUserSettingsPath(env);
  const workspacePath = getWorkspaceSettingsPath(cwd);
  const user = readSettingsFile(userPath);
  const workspace = readSettingsFile(workspacePath);
  const sourceValues = getSettingsValueSources({
    user,
    workspace,
    env,
    activeTenantId: args.activeTenantId
  });
  for (const [key, value] of Object.entries(args.flagOverrides ?? {}) as Array<[SettingPath, unknown]>) {
    if (value === undefined) {
      continue;
    }
    sourceValues[key] = {
      value: validateSettingValue(key, value),
      source: 'flag'
    };
  }
  const resolved = buildResolvedSettings(sourceValues);
  const sources = Object.fromEntries(
    Object.entries(sourceValues).map(([key, value]) => [key, value.source])
  ) as ResolvedCliSettingsState['sources'];

  return {
    paths: {
      configDir: getXyteConfigDir(env),
      user: userPath,
      workspace: workspacePath
    },
    user,
    workspace,
    values: resolved,
    sources
  };
}

export function parseSettingValue(keyPath: string, rawValue: string): unknown {
  if (!SETTING_PATHS.includes(keyPath as SettingPath)) {
    throw new Error(`Unknown config key: ${keyPath}.`);
  }
  return validateSettingValue(keyPath as SettingPath, rawValue);
}

export function setCliSettingSync(args: {
  scope: Exclude<CliSettingsScope, 'resolved'>;
  key: SettingKey;
  value: unknown;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): { path: string; data: CliSettingsFile } {
  const cwd = args.cwd ?? process.cwd();
  const env = args.env ?? process.env;
  const filePath = args.scope === 'user' ? getUserSettingsPath(env) : getWorkspaceSettingsPath(cwd);
  const settings = readCliSettingsFile(args.scope, cwd, env);
  const next = cloneSettings(settings) as Record<string, unknown>;
  setPathValue(next, args.key, validateSettingValue(args.key, args.value));
  next.version = 'settings.v1';
  writeSettingsFile(filePath, next as CliSettingsFile);
  return {
    path: filePath,
    data: next as CliSettingsFile
  };
}

export function unsetCliSettingSync(args: {
  scope: Exclude<CliSettingsScope, 'resolved'>;
  key: SettingKey;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): { path: string; data: CliSettingsFile } {
  const cwd = args.cwd ?? process.cwd();
  const env = args.env ?? process.env;
  const filePath = args.scope === 'user' ? getUserSettingsPath(env) : getWorkspaceSettingsPath(cwd);
  const settings = readCliSettingsFile(args.scope, cwd, env);
  const next = cloneSettings(settings) as Record<string, unknown>;
  unsetPathValue(next, args.key);
  next.version = 'settings.v1';
  writeSettingsFile(filePath, next as CliSettingsFile);
  return {
    path: filePath,
    data: next as CliSettingsFile
  };
}
