export function parseJsonObject(value: string | undefined, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  if (!value) {
    return fallback;
  }

  const parsed = JSON.parse(value) as unknown;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Expected a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

export function tryParseJson<T = unknown>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function extractFirstJsonObject<T = unknown>(text: string): T | undefined {
  const direct = tryParseJson<T>(text.trim());
  if (direct !== undefined) {
    return direct;
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }

  return tryParseJson<T>(text.slice(start, end + 1));
}
