import { parseJsonObject } from '../utils/json';

export function parseQueryJson(
  value: string | undefined
): Record<string, string | number | boolean | null | undefined> {
  const record = parseJsonObject(value);
  const out: Record<string, string | number | boolean | null | undefined> = {};
  for (const [key, item] of Object.entries(record)) {
    if (
      item === null ||
      item === undefined ||
      typeof item === 'string' ||
      typeof item === 'number' ||
      typeof item === 'boolean'
    ) {
      out[key] = item as string | number | boolean | null | undefined;
      continue;
    }
    throw new Error(`Query parameter "${key}" must be scalar, null, or undefined.`);
  }
  return out;
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
