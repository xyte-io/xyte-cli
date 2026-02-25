import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';

import {
  extractCommandPathFromLogEntry,
  resolveCliActionLogPath,
  type CliActionLogEntry
} from './action-logger';

export interface ReadCliActionLogOptions {
  path?: string;
  limit?: number;
  event?: string;
  command?: string;
}

export interface ReadCliActionLogResult {
  path: string;
  entries: CliActionLogEntry[];
  parseErrors: number;
}

const READ_CHUNK_BYTES = 64 * 1024;

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) {
    return undefined;
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    return 1;
  }
  return Math.min(Math.floor(limit), 5000);
}

function parseEntry(line: string): CliActionLogEntry | undefined {
  try {
    const parsed = JSON.parse(line) as Partial<CliActionLogEntry>;
    if (!parsed || typeof parsed !== 'object') {
      return undefined;
    }
    if (typeof parsed.seq !== 'number' || typeof parsed.timestamp !== 'string' || typeof parsed.event !== 'string') {
      return undefined;
    }
    if (typeof parsed.pid !== 'number' || typeof parsed.sessionId !== 'string') {
      return undefined;
    }
    if (parsed.level !== 'info' && parsed.level !== 'error') {
      return undefined;
    }
    return parsed as CliActionLogEntry;
  } catch {
    return undefined;
  }
}

function entryMatchesFilters(entry: CliActionLogEntry, eventFilter: string | undefined, commandFilter: string | undefined): boolean {
  if (eventFilter && entry.event !== eventFilter) {
    return false;
  }
  if (!commandFilter) {
    return true;
  }
  const commandPath = (extractCommandPathFromLogEntry(entry) ?? '').toLowerCase();
  return commandPath.includes(commandFilter);
}

function scanLogLinesFromEnd(filePath: string, onLine: (line: string) => void, shouldStop: () => boolean): void {
  const fd = openSync(filePath, 'r');
  try {
    const totalBytes = statSync(filePath).size;
    let position = totalBytes;
    let carry = '';

    while (position > 0 && !shouldStop()) {
      const bytesToRead = Math.min(READ_CHUNK_BYTES, position);
      position -= bytesToRead;

      const buffer = Buffer.allocUnsafe(bytesToRead);
      const bytesRead = readSync(fd, buffer, 0, bytesToRead, position);
      if (bytesRead <= 0) {
        break;
      }

      const chunk = buffer.toString('utf8', 0, bytesRead);
      const text = chunk + carry;
      const parts = text.split('\n');
      carry = parts.shift() ?? '';

      for (let index = parts.length - 1; index >= 0; index -= 1) {
        if (shouldStop()) {
          return;
        }
        const line = parts[index].trim();
        if (!line) {
          continue;
        }
        onLine(line);
      }
    }

    if (!shouldStop()) {
      const firstLine = carry.trim();
      if (firstLine) {
        onLine(firstLine);
      }
    }
  } finally {
    closeSync(fd);
  }
}

export function readCliActionLog(options: ReadCliActionLogOptions = {}): ReadCliActionLogResult {
  const path = resolveCliActionLogPath(options.path);
  if (!existsSync(path)) {
    return {
      path,
      entries: [],
      parseErrors: 0
    };
  }

  const maxEntries = normalizeLimit(options.limit);
  const eventFilter = options.event?.trim();
  const commandFilter = options.command?.trim().toLowerCase();

  const entries: CliActionLogEntry[] = [];
  let parseErrors = 0;

  scanLogLinesFromEnd(
    path,
    (line) => {
      const parsed = parseEntry(line);
      if (!parsed) {
        parseErrors += 1;
        return;
      }
      if (!entryMatchesFilters(parsed, eventFilter, commandFilter)) {
        return;
      }

      entries.push(parsed);
    },
    () => maxEntries !== undefined && entries.length >= maxEntries
  );

  entries.reverse();
  return {
    path,
    entries,
    parseErrors
  };
}
