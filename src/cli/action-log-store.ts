import { existsSync, readFileSync } from 'node:fs';

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
  const lines = readFileSync(path, 'utf8').split('\n');
  const entries: CliActionLogEntry[] = [];
  let parseErrors = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }

    const parsed = parseEntry(line);
    if (!parsed) {
      parseErrors += 1;
      continue;
    }
    if (!entryMatchesFilters(parsed, eventFilter, commandFilter)) {
      continue;
    }

    entries.push(parsed);
    if (maxEntries !== undefined && entries.length >= maxEntries) {
      break;
    }
  }

  entries.reverse();
  return {
    path,
    entries,
    parseErrors
  };
}
