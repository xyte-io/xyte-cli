import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface TuiLogger {
  readonly enabled: boolean;
  readonly path?: string;
  log(event: string, data?: Record<string, unknown>): void;
  close(): void;
}

export interface CreateTuiLoggerOptions {
  enabled?: boolean;
  path?: string;
}

function defaultDebugPath(): string {
  return resolve(homedir(), '.xyte', 'logs', 'tui-debug.log');
}

function toSerializable(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  return value;
}

function serialize(data: Record<string, unknown> | undefined): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    data,
    (_key, value) => {
      const serializable = toSerializable(value);
      if (!serializable || typeof serializable !== 'object') {
        return serializable;
      }
      if (seen.has(serializable as object)) {
        return '[Circular]';
      }
      seen.add(serializable as object);
      return serializable;
    }
  );
}

function noopLogger(): TuiLogger {
  return {
    enabled: false,
    log() {
      // no-op
    },
    close() {
      // no-op
    }
  };
}

export function createTuiLogger(options: CreateTuiLoggerOptions = {}): TuiLogger {
  if (!options.enabled) {
    return noopLogger();
  }

  const filePath = resolve(options.path ?? defaultDebugPath());
  let sequence = 0;
  try {
    mkdirSync(dirname(filePath), { recursive: true });
  } catch {
    return noopLogger();
  }

  const logger: TuiLogger = {
    enabled: true,
    path: filePath,
    log(event, data) {
      try {
        sequence += 1;
        const payload = {
          seq: sequence,
          timestamp: new Date().toISOString(),
          pid: process.pid,
          event,
          data
        };
        appendFileSync(filePath, `${serialize(payload)}\n`, { encoding: 'utf8' });
      } catch {
        // best-effort logger
      }
    },
    close() {
      // no-op for appendFileSync logger
    }
  };

  logger.log('logger.started', { path: filePath });
  return logger;
}
