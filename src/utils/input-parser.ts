import { readFileSync } from 'node:fs';
import path from 'node:path';

export type UtilityInputFormat = 'auto' | 'csv' | 'json' | 'jsonl';

interface LoadedUtilityInputRows {
  format: Exclude<UtilityInputFormat, 'auto'>;
  rows: Array<Record<string, unknown>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function detectInputFormat(inputPath: string, raw: string): Exclude<UtilityInputFormat, 'auto'> {
  const extension = path.extname(inputPath).toLowerCase();
  if (extension === '.csv') {
    return 'csv';
  }
  if (extension === '.json') {
    return 'json';
  }
  if (extension === '.jsonl' || extension === '.ndjson') {
    return 'jsonl';
  }

  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    return 'json';
  }
  if (trimmed.startsWith('{')) {
    return 'jsonl';
  }
  return 'csv';
}

function parseCsvRows(raw: string): string[][] {
  const text = raw.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    if (char === '\r') {
      if (text[index + 1] === '\n') {
        index += 1;
      }
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += char;
  }

  row.push(field);
  rows.push(row);

  while (rows.length > 0) {
    const maybeEmpty = rows[rows.length - 1];
    if (maybeEmpty.length === 1 && maybeEmpty[0].trim() === '') {
      rows.pop();
      continue;
    }
    break;
  }

  return rows;
}

function parseCsv(raw: string): Array<Record<string, unknown>> {
  const rows = parseCsvRows(raw);
  if (rows.length === 0) {
    return [];
  }

  const headers = rows[0].map((value) => value.trim());
  if (headers.some((header) => !header)) {
    throw new Error('CSV header row contains empty column names.');
  }

  const output: Array<Record<string, unknown>> = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex];
    if (row.every((value) => value.trim() === '')) {
      continue;
    }

    if (row.length > headers.length) {
      throw new Error(`CSV row ${rowIndex + 1} has more fields than header columns.`);
    }

    const padded = row.concat(new Array(headers.length - row.length).fill(''));
    const item: Record<string, unknown> = {};
    for (let index = 0; index < headers.length; index += 1) {
      item[headers[index]] = padded[index];
    }
    output.push(item);
  }

  return output;
}

function parseJsonArray(raw: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('JSON input is invalid.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('JSON input must be an array of objects.');
  }

  return parsed.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`JSON row ${index + 1} must be an object.`);
    }
    return item;
  });
}

function parseJsonLines(raw: string): Array<Record<string, unknown>> {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`JSONL row ${index + 1} is invalid JSON.`);
    }
    if (!isRecord(parsed)) {
      throw new Error(`JSONL row ${index + 1} must be an object.`);
    }
    return parsed;
  });
}

export function loadInputRows(inputPath: string, format: UtilityInputFormat = 'auto'): LoadedUtilityInputRows {
  const raw = readFileSync(inputPath, 'utf8');
  const resolvedFormat = format === 'auto' ? detectInputFormat(inputPath, raw) : format;

  if (resolvedFormat === 'csv') {
    return {
      format: resolvedFormat,
      rows: parseCsv(raw)
    };
  }

  if (resolvedFormat === 'json') {
    return {
      format: resolvedFormat,
      rows: parseJsonArray(raw)
    };
  }

  return {
    format: resolvedFormat,
    rows: parseJsonLines(raw)
  };
}
