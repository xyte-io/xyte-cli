import { mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import Fuse from 'fuse.js';
import { z } from 'zod';

import { DEVICE_MATCH_SCHEMA_VERSION } from '../contracts/versions';
import { isRecord } from '../utils/json';
import { loadInputRows } from '../utils/input-parser';

type MatchStatus = 'exact' | 'fuzzy' | 'unmatched';

interface DeviceMatchRow {
  deviceId: string;
  deviceName: string;
  targetSpaceId?: string;
  targetSpaceName?: string;
  confidence: number;
  status: MatchStatus;
}

export interface DeviceMatchResult {
  schemaVersion: typeof DEVICE_MATCH_SCHEMA_VERSION;
  generatedAtUtc: string;
  tenantId?: string;
  sourcePath: string;
  targetPath: string;
  sourceField: string;
  targetField: string;
  outputPath: string;
  summaryPath: string;
  totals: {
    rows: number;
    exact: number;
    fuzzy: number;
    unmatched: number;
  };
  matches: DeviceMatchRow[];
}

const DeviceMatchRowSchema = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  targetSpaceId: z.string().optional(),
  targetSpaceName: z.string().optional(),
  confidence: z.number(),
  status: z.enum(['exact', 'fuzzy', 'unmatched'])
});

export const DeviceMatchResultSchema = z.object({
  schemaVersion: z.literal(DEVICE_MATCH_SCHEMA_VERSION),
  generatedAtUtc: z.string(),
  tenantId: z.string().optional(),
  sourcePath: z.string(),
  targetPath: z.string(),
  sourceField: z.string(),
  targetField: z.string(),
  outputPath: z.string(),
  summaryPath: z.string(),
  totals: z.object({
    rows: z.number(),
    exact: z.number(),
    fuzzy: z.number(),
    unmatched: z.number()
  }),
  matches: z.array(DeviceMatchRowSchema)
});

interface MatchTarget {
  id: string;
  name: string;
  [key: string]: string;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function countCoveredCharacters(indices: ReadonlyArray<readonly [number, number]> | undefined): number {
  if (!indices || indices.length === 0) {
    return 0;
  }

  const covered = new Set<number>();
  for (const [start, end] of indices) {
    for (let index = start; index <= end; index += 1) {
      covered.add(index);
    }
  }
  return covered.size;
}

function quoteCsvField(value: string): string {
  if (!/[",\n\r]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

async function writeCsv(outputPath: string, rows: DeviceMatchRow[]): Promise<void> {
  const lines = ['device_id,device_name,target_space_id,target_space_name,confidence'];
  for (const row of rows) {
    lines.push(
      [
        row.deviceId,
        row.deviceName,
        row.targetSpaceId ?? '',
        row.targetSpaceName ?? '',
        row.confidence.toFixed(3)
      ]
        .map((value) => quoteCsvField(value))
        .join(',')
    );
  }
  await writeFile(outputPath, `${lines.join('\n')}\n`, 'utf8');
}

function toObjectRows(items: unknown[]): Array<Record<string, unknown>> {
  return items.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`JSON row ${index + 1} must be an object.`);
    }
    return item;
  });
}

function extractRowsFromJson(value: unknown): Array<Record<string, unknown>> | undefined {
  if (Array.isArray(value)) {
    return toObjectRows(value);
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if (Array.isArray(value.items)) {
    return toObjectRows(value.items);
  }

  if (isRecord(value.response)) {
    const nested = extractRowsFromJson(value.response);
    if (nested) {
      return nested;
    }
  }

  if (isRecord(value.data)) {
    const nested = extractRowsFromJson(value.data);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

async function loadMatchRows(inputPath: string): Promise<Array<Record<string, unknown>>> {
  const resolved = path.resolve(inputPath);
  const raw = await readFile(resolved, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`Input file ${resolved}: ${(error as Error).message}`, { cause: error });
    }
    const extracted = extractRowsFromJson(parsed);
    if (extracted) {
      return extracted;
    }
  }

  return loadInputRows(resolved, 'auto').rows;
}

function requireStringField(row: Record<string, unknown>, fieldName: string, rowIndex: number): string {
  const value = row[fieldName];
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`Row ${rowIndex}: field "${fieldName}" must be a string or number.`);
  }
  const normalized = String(value).trim();
  if (!normalized) {
    throw new Error(`Row ${rowIndex}: field "${fieldName}" cannot be empty.`);
  }
  return normalized;
}

export async function runDeviceMatch(args: {
  sourcePath: string;
  targetPath: string;
  sourceField: string;
  targetField: string;
  outputPath: string;
  tenantId?: string;
}): Promise<DeviceMatchResult> {
  const sourcePath = path.resolve(args.sourcePath);
  const targetPath = path.resolve(args.targetPath);
  const outputPath = path.resolve(args.outputPath);
  const summaryPath = `${outputPath}.summary.json`;

  const sourceRows = await loadMatchRows(sourcePath);
  const targetRows = await loadMatchRows(targetPath);
  const targets: MatchTarget[] = targetRows.map((row, index) => {
    const targetName = requireStringField(row, args.targetField, index + 1);
    return {
      id: requireStringField(row, 'id', index + 1),
      name: targetName,
      [args.targetField]: targetName
    };
  });
  const exactTargets = new Map<string, MatchTarget>();
  for (const target of targets) {
    exactTargets.set(normalizeName(target.name), target);
  }
  const fuse = new Fuse(targets, {
    keys: [args.targetField],
    includeScore: true,
    includeMatches: true,
    minMatchCharLength: 3
  });

  const matches: DeviceMatchRow[] = sourceRows.map((row, index) => {
    const rowIndex = index + 1;
    const deviceId = requireStringField(row, 'id', rowIndex);
    const deviceName = requireStringField(row, args.sourceField, rowIndex);
    const normalizedDeviceName = normalizeName(deviceName);
    const exactTarget = exactTargets.get(normalizedDeviceName);
    if (exactTarget) {
      return {
        deviceId,
        deviceName,
        targetSpaceId: exactTarget.id,
        targetSpaceName: exactTarget.name,
        confidence: 1,
        status: 'exact'
      };
    }
    const bestMatch = fuse.search(deviceName, { limit: 1 })[0];

    if (!bestMatch) {
      return {
        deviceId,
        deviceName,
        confidence: 0,
        status: 'unmatched'
      };
    }

    const normalizedTargetName = normalizeName(bestMatch.item.name);
    const matchedCharacters = countCoveredCharacters(bestMatch.matches?.[0]?.indices);
    const denominator = Math.max(normalizedDeviceName.length, normalizedTargetName.length, 1);
    const confidence = Number((matchedCharacters / denominator).toFixed(3));
    return {
      deviceId,
      deviceName,
      targetSpaceId: bestMatch.item.id,
      targetSpaceName: bestMatch.item.name,
      confidence,
      status: 'fuzzy'
    };
  });

  mkdirSync(path.dirname(outputPath), { recursive: true });
  await writeCsv(outputPath, matches);

  const result: DeviceMatchResult = {
    schemaVersion: DEVICE_MATCH_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    ...(args.tenantId ? { tenantId: args.tenantId } : {}),
    sourcePath,
    targetPath,
    sourceField: args.sourceField,
    targetField: args.targetField,
    outputPath,
    summaryPath,
    totals: {
      rows: matches.length,
      exact: matches.filter((row) => row.status === 'exact').length,
      fuzzy: matches.filter((row) => row.status === 'fuzzy').length,
      unmatched: matches.filter((row) => row.status === 'unmatched').length
    },
    matches
  };

  await writeFile(summaryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}
