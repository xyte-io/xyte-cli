export function parseJsonObject(value: string | undefined, fallback: Record<string, unknown> = {}): Record<string, unknown> {
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
