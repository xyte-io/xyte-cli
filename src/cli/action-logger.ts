import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync
} from 'node:fs';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';

import { getXyteConfigDir } from '../utils/config-dir';
import { isRecord } from '../utils/json';
import { redactSensitiveData, redactSensitiveText } from '../utils/redact';

export type CliActionLogLevel = 'info' | 'error';

export interface CliActionLogEntry {
  seq: number;
  timestamp: string;
  pid: number;
  sessionId: string;
  level: CliActionLogLevel;
  event: string;
  commandPath?: string;
  data?: unknown;
}

export interface CliActionLogger {
  readonly enabled: boolean;
  readonly path?: string;
  readonly sessionId: string;
  log(event: string, data?: Record<string, unknown>, level?: CliActionLogLevel): void;
  close(): void;
}

interface CreateCliActionLoggerOptions {
  enabled?: boolean;
  path?: string;
  mirrorToStderr?: boolean;
  stderr?: Pick<typeof process.stderr, 'write'>;
  sessionId?: string;
  argv?: string[];
  maxFileBytes?: number;
  maxFiles?: number;
}

interface CliActionLogFileInfo {
  path: string;
  kind: 'active' | 'rotated';
  index: number;
  sizeBytes: number;
  modifiedAtMs: number;
  modifiedAtUtc: string;
}

interface GcCliActionLogOptions {
  path?: string;
  maxFiles?: number;
  maxAgeMs?: number;
  dryRun?: boolean;
}

interface GcCliActionLogResult {
  path: string;
  removed: string[];
  kept: string[];
}

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

const SENSITIVE_ARG_FLAGS = new Set([
  '--key',
  '--api-key',
  '--x-api-key',
  '--token',
  '--access-token',
  '--refresh-token',
  '--secret',
  '--client-secret',
  '--private-key',
  '--password',
  '--passwd',
  '--pwd',
  '--authorization',
  '--bearer'
]);

const SENSITIVE_OPTION_FIELDS = new Set([
  'key',
  'apikey',
  'api_key',
  'xapikey',
  'x_api_key',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'secret',
  'clientsecret',
  'client_secret',
  'privatekey',
  'private_key',
  'password',
  'passwd',
  'pwd',
  'authorization',
  'bearer'
]);

function normalizeSensitiveKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function normalizePositiveInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

function escapeRegexText(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function redactCliOptionValue(value: unknown, inOptionsContext: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactCliOptionValue(item, inOptionsContext));
  }

  if (!isRecord(value)) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    const nestedInOptions = inOptionsContext || key === 'options';
    if (nestedInOptions && SENSITIVE_OPTION_FIELDS.has(normalizeSensitiveKey(key)) && nested !== null && nested !== undefined) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = redactCliOptionValue(nested, nestedInOptions);
  }
  return output;
}

function sanitizeForJson(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const serialized = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') {
      return item.toString();
    }
    if (item instanceof Error) {
      return {
        name: item.name,
        message: item.message,
        stack: item.stack
      };
    }
    if (item && typeof item === 'object') {
      if (seen.has(item as object)) {
        return '[Circular]';
      }
      seen.add(item as object);
    }
    return item;
  });

  if (!serialized) {
    return undefined;
  }
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    return undefined;
  }
}

function parseArgToken(token: string): { flag: string; hasInlineValue: boolean } {
  const separator = token.indexOf('=');
  if (separator === -1) {
    return { flag: token, hasInlineValue: false };
  }
  return {
    flag: token.slice(0, separator),
    hasInlineValue: true
  };
}

function defaultCliActionLogPath(): string {
  return resolvePath(getXyteConfigDir(), 'logs', 'cli-actions.ndjson');
}

function applySecureDirectoryPermissions(logPath: string): void {
  const dir = dirname(logPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best-effort permissions hardening
  }
}

function applySecureFilePermissions(logPath: string): void {
  try {
    chmodSync(logPath, 0o600);
  } catch {
    // best-effort permissions hardening
  }
}

function rotatedLogPath(basePath: string, index: number): string {
  if (index <= 0) {
    return basePath;
  }
  return `${basePath}.${index}`;
}

function rotateLogFiles(basePath: string, maxFiles: number): void {
  if (!existsSync(basePath)) {
    return;
  }

  const rotatedCount = Math.max(0, maxFiles - 1);
  if (rotatedCount === 0) {
    // maxFiles=1 intentionally keeps no rotation history: drop the current file and start fresh on next write.
    rmSync(basePath, { force: true });
    return;
  }

  rmSync(rotatedLogPath(basePath, rotatedCount), { force: true });
  for (let index = rotatedCount - 1; index >= 1; index -= 1) {
    const source = rotatedLogPath(basePath, index);
    const destination = rotatedLogPath(basePath, index + 1);
    if (existsSync(source)) {
      renameSync(source, destination);
    }
  }

  renameSync(basePath, rotatedLogPath(basePath, 1));
}

function maybeRotate(basePath: string, nextPayloadSizeBytes: number, maxFileBytes: number, maxFiles: number): void {
  if (!existsSync(basePath)) {
    return;
  }

  let currentSize = 0;
  try {
    currentSize = statSync(basePath).size;
  } catch {
    return;
  }

  if (currentSize + nextPayloadSizeBytes <= maxFileBytes) {
    return;
  }

  rotateLogFiles(basePath, maxFiles);
}

function extractCommandPathFromData(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const value = data.commandPath;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function formatMirrorLine(entry: CliActionLogEntry): string {
  const level = entry.level.toUpperCase();
  const commandPath = extractCommandPathFromLogEntry(entry);
  const data = isRecord(entry.data) ? entry.data : undefined;
  const durationMs = typeof data?.durationMs === 'number' ? Math.round(data.durationMs) : undefined;
  const parts = ['[xyte-cli]', entry.timestamp, level, entry.event];
  if (commandPath) {
    parts.push(commandPath);
  }
  if (durationMs !== undefined) {
    parts.push(`${durationMs}ms`);
  }
  return `${parts.join(' ')}\n`;
}

function createNoopLogger(path: string | undefined, sessionId: string): CliActionLogger {
  return {
    enabled: false,
    path,
    sessionId,
    log() {
      // no-op
    },
    close() {
      // no-op
    }
  };
}

export function sanitizeArgvForLog(argv: string[]): string[] {
  const sanitized: string[] = [];
  let redactNext = false;

  for (const item of argv) {
    if (redactNext) {
      sanitized.push('[REDACTED]');
      redactNext = false;
      continue;
    }

    const token = String(item ?? '');
    const parsed = parseArgToken(token);
    const isSensitive = SENSITIVE_ARG_FLAGS.has(parsed.flag.toLowerCase());

    if (isSensitive && parsed.hasInlineValue) {
      sanitized.push(`${parsed.flag}=[REDACTED]`);
      continue;
    }

    if (isSensitive) {
      sanitized.push(parsed.flag);
      redactNext = true;
      continue;
    }

    sanitized.push(redactSensitiveText(token));
  }

  return sanitized;
}

export function resolveCliActionLogPath(pathOverride?: string): string {
  return resolvePath(pathOverride ?? defaultCliActionLogPath());
}

export function extractCommandPathFromLogEntry(entry: Pick<CliActionLogEntry, 'commandPath' | 'data'>): string | undefined {
  return entry.commandPath ?? extractCommandPathFromData(entry.data);
}

export function listCliActionLogFiles(pathOverride?: string): CliActionLogFileInfo[] {
  const basePath = resolveCliActionLogPath(pathOverride);
  const out: CliActionLogFileInfo[] = [];

  if (existsSync(basePath)) {
    const stats = statSync(basePath);
    out.push({
      path: basePath,
      kind: 'active',
      index: 0,
      sizeBytes: stats.size,
      modifiedAtMs: stats.mtimeMs,
      modifiedAtUtc: new Date(stats.mtimeMs).toISOString()
    });
  }

  const baseName = basename(basePath);
  const dir = dirname(basePath);
  if (!existsSync(dir)) {
    return out;
  }

  const rotatedPattern = new RegExp(`^${escapeRegexText(baseName)}\\.(\\d+)$`);
  const rotated: CliActionLogFileInfo[] = [];

  for (const name of readdirSync(dir)) {
    const match = rotatedPattern.exec(name);
    if (!match) {
      continue;
    }

    const index = Number.parseInt(match[1], 10);
    if (!Number.isFinite(index) || index <= 0) {
      continue;
    }

    const filePath = join(dir, name);
    try {
      const stats = statSync(filePath);
      rotated.push({
        path: filePath,
        kind: 'rotated',
        index,
        sizeBytes: stats.size,
        modifiedAtMs: stats.mtimeMs,
        modifiedAtUtc: new Date(stats.mtimeMs).toISOString()
      });
    } catch {
      // best-effort listing
    }
  }

  rotated.sort((a, b) => a.index - b.index);
  return [...out, ...rotated];
}

export function gcCliActionLogFiles(options: GcCliActionLogOptions = {}): GcCliActionLogResult {
  const basePath = resolveCliActionLogPath(options.path);
  const files = listCliActionLogFiles(basePath);
  const maxFiles = normalizePositiveInt(options.maxFiles, DEFAULT_MAX_FILES, 1, 1000);
  const maxAgeMs = options.maxAgeMs;
  const now = Date.now();

  const active = files.find((item) => item.kind === 'active');
  const rotated = files.filter((item) => item.kind === 'rotated').sort((a, b) => a.index - b.index);

  const keepRotatedCount = Math.max(0, maxFiles - (active ? 1 : 0));
  const removeByCount = rotated.slice(keepRotatedCount);
  const removeByAge =
    maxAgeMs && Number.isFinite(maxAgeMs) && maxAgeMs > 0
      ? rotated.filter((item) => now - item.modifiedAtMs > maxAgeMs)
      : [];

  const removedSet = new Set<string>([...removeByCount, ...removeByAge].map((item) => item.path));
  if (!options.dryRun) {
    for (const filePath of removedSet) {
      rmSync(filePath, { force: true });
    }
  }

  // Re-list after deletion attempts so kept reflects the actual on-disk state (including force-delete no-ops).
  const keptFiles = listCliActionLogFiles(basePath).map((item) => item.path);
  if (active && !keptFiles.includes(active.path) && !options.dryRun) {
    // base file may be absent if log has not been written yet after cleanup
  }

  return {
    path: basePath,
    removed: Array.from(removedSet).sort((a, b) => a.localeCompare(b)),
    kept: options.dryRun ? files.filter((item) => !removedSet.has(item.path)).map((item) => item.path) : keptFiles
  };
}

export function createCliActionLogger(options: CreateCliActionLoggerOptions = {}): CliActionLogger {
  const path = resolveCliActionLogPath(options.path);
  const sessionId = options.sessionId?.trim() || randomUUID();

  if (!options.enabled) {
    return createNoopLogger(path, sessionId);
  }

  try {
    applySecureDirectoryPermissions(path);
  } catch {
    return createNoopLogger(path, sessionId);
  }

  const maxFileBytes = normalizePositiveInt(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 1024, 1024 * 1024 * 1024);
  const maxFiles = normalizePositiveInt(options.maxFiles, DEFAULT_MAX_FILES, 1, 1000);

  let sequence = 0;
  let closed = false;

  const writeEntry = (event: string, data: Record<string, unknown> | undefined, level: CliActionLogLevel): void => {
    try {
      sequence += 1;
      const serializedData = data === undefined ? undefined : sanitizeForJson(data);
      const withCliOptionRedaction = serializedData === undefined ? undefined : redactCliOptionValue(serializedData, false);
      const redactedData = withCliOptionRedaction === undefined ? undefined : (redactSensitiveData(withCliOptionRedaction) as unknown);

      const entry: CliActionLogEntry = {
        seq: sequence,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        sessionId,
        level,
        event,
        commandPath: extractCommandPathFromData(redactedData),
        data: redactedData
      };

      const line = `${JSON.stringify(entry)}\n`;
      maybeRotate(path, Buffer.byteLength(line, 'utf8'), maxFileBytes, maxFiles);
      appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
      applySecureFilePermissions(path);

      if (options.mirrorToStderr && options.stderr) {
        options.stderr.write(formatMirrorLine(entry));
      }
    } catch {
      // best-effort logger
    }
  };

  const logger: CliActionLogger = {
    enabled: true,
    path,
    sessionId,
    log(event, data, level = 'info') {
      if (closed) {
        return;
      }
      writeEntry(event, data, level);
    },
    close() {
      if (closed) {
        return;
      }
      writeEntry('session.end', { reason: 'close' }, 'info');
      closed = true;
    }
  };

  const sessionStartData: Record<string, unknown> = { path };
  if (options.argv && options.argv.length > 0) {
    sessionStartData.argv = sanitizeArgvForLog(options.argv);
  }
  writeEntry('session.start', sessionStartData, 'info');

  return logger;
}
