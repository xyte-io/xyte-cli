import { describe, expect, it } from 'vitest';

import { CliUserError } from '../src/contracts/user-error';
import { parseJsonObject } from '../src/utils/json';

describe('parseJsonObject', () => {
  it('returns fallback when value is missing', () => {
    expect(parseJsonObject(undefined, { keep: true })).toEqual({ keep: true });
  });

  it('throws CliUserError with parse detail for invalid JSON text', () => {
    expect(() => parseJsonObject('{invalid')).toThrow(CliUserError);
    try {
      parseJsonObject('{invalid');
    } catch (e) {
      expect(e).toBeInstanceOf(CliUserError);
      expect((e as CliUserError).summary).toBe('Invalid JSON.');
      expect((e as CliUserError).detail).toBeTruthy();
    }
  });

  it('keeps object-shape validation separate from parse errors', () => {
    expect(() => parseJsonObject('[]')).toThrow('Expected a JSON object.');
  });
});
