import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';

import { getXyteConfigDir } from '../utils/config-dir';
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

export interface CreateCliActionLoggerOptions {
  enabled?: boolean;
  path?: string;
  mirrorToStderr?: boolean;
  stderr?: Pick<typeof process.stderr, 'write'>;
  sessionId?: string;
  argv?: string[];
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSensitiveKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
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
  return JSON.parse(serialized) as unknown;
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

function defaultCliActionLogPath(): string {
  return resolvePath(getXyteConfigDir(), 'logs', 'cli-actions.ndjson');
}

export function resolveCliActionLogPath(pathOverride?: string): string {
  return resolvePath(pathOverride ?? defaultCliActionLogPath());
}

function extractCommandPathFromData(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const value = data.commandPath;
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function extractCommandPathFromLogEntry(entry: Pick<CliActionLogEntry, 'commandPath' | 'data'>): string | undefined {
  return entry.commandPath ?? extractCommandPathFromData(entry.data);
}

function formatMirrorLine(entry: CliActionLogEntry): string {
  const level = entry.level.toUpperCase();
  const commandPath = extractCommandPathFromLogEntry(entry);
  const data = isRecord(entry.data) ? entry.data : undefined;
  const durationMs = typeof data?.durationMs === 'number' ? Math.round(data.durationMs) : undefined;
  const parts = [`[xyte-cli]`, entry.timestamp, level, entry.event];
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

export function createCliActionLogger(options: CreateCliActionLoggerOptions = {}): CliActionLogger {
  const path = resolveCliActionLogPath(options.path);
  const sessionId = options.sessionId?.trim() || randomUUID();

  if (!options.enabled) {
    return createNoopLogger(path, sessionId);
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    return createNoopLogger(path, sessionId);
  }

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

      appendFileSync(path, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
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

  writeEntry(
    'session.start',
    {
      path,
      cwd: process.cwd(),
      argv: sanitizeArgvForLog(options.argv ?? process.argv.slice(2))
    },
    'info'
  );

  return logger;
}
