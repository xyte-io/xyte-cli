import { asRecord, extractArray } from './json';

export function extractIncidentsArray(value: unknown): unknown[] {
  const primary = extractArray(value, ['incidents', 'data', 'items']);
  if (primary.length > 0) {
    return primary;
  }

  const record = asRecord(value);
  const wrappers = ['payload', 'result', 'response', 'body'];
  for (const wrapper of wrappers) {
    const nested = extractArray(record[wrapper], ['incidents', 'data', 'items']);
    if (nested.length > 0) {
      return nested;
    }
  }

  return primary;
}
