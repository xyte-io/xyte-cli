export function safeString(value: unknown): string {
  if (value === undefined || value === null) {
    return 'n/a';
  }
  return String(value);
}

export function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function extractArray(value: unknown, preferredKeys: string[] = ['data', 'items']): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  const record = asRecord(value);
  for (const key of preferredKeys) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
    }
  }

  for (const key of Object.keys(record)) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
    }
  }

  return [];
}

export function extractHasNextPage(value: unknown): boolean | undefined {
  const record = asRecord(value);
  if (typeof record.has_next_page === 'boolean') {
    return record.has_next_page;
  }
  const data = asRecord(record.data);
  if (typeof data.has_next_page === 'boolean') {
    return data.has_next_page;
  }
  return undefined;
}

export function parseJsonObject(
  value: string | undefined,
  fallback: Record<string, unknown> = {}
): Record<string, unknown> {
  if (!value) {
    return fallback;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    const detail = error instanceof Error && error.message.trim().length > 0 ? `: ${error.message}` : '.';
    throw new Error(`Invalid JSON${detail}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Expected a JSON object.');
  }

  return parsed as Record<string, unknown>;
}
