import { describe, expect, it } from 'vitest';

import { parseJsonObject } from '../src/utils/json';

describe('parseJsonObject', () => {
  it('returns fallback when value is missing', () => {
    expect(parseJsonObject(undefined, { keep: true })).toEqual({ keep: true });
  });

  it('throws a parse-specific error for invalid JSON text', () => {
    expect(() => parseJsonObject('{invalid')).toThrow('Invalid JSON:');
  });

  it('keeps object-shape validation separate from parse errors', () => {
    expect(() => parseJsonObject('[]')).toThrow('Expected a JSON object.');
  });
});
