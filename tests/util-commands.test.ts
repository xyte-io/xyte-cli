import { describe, expect, it } from 'vitest';

// Test the pure parsing logic extracted from util.ts
// Since the parsing functions are private to util.ts, we test them through the public API indirectly
// by testing the underlying patterns they use.

import { parseCliOutputMode } from '../src/cli/cli-context';
import { parseQueryJson } from '../src/cli/parse-options';

describe('util command parsing patterns', () => {
  describe('parseQueryJson for util commands', () => {
    it('handles typical utility prepare JSON', () => {
      const result = parseQueryJson('{"page":1,"per_page":100}');
      expect(result).toEqual({ page: 1, per_page: 100 });
    });

    it('rejects nested objects', () => {
      expect(() => parseQueryJson('{"nested":{"a":1}}')).toThrow('must be scalar');
    });
  });

  describe('output mode parsing for util commands', () => {
    it('accepts json mode', () => {
      expect(parseCliOutputMode('json')).toBe('json');
    });

    it('accepts text mode', () => {
      expect(parseCliOutputMode('text')).toBe('text');
    });

    it('accepts auto mode', () => {
      expect(parseCliOutputMode('auto')).toBe('auto');
    });

    it('is case insensitive', () => {
      expect(parseCliOutputMode('JSON')).toBe('json');
      expect(parseCliOutputMode('Text')).toBe('text');
    });

    it('rejects invalid modes', () => {
      expect(() => parseCliOutputMode('csv')).toThrow('Invalid output mode');
    });
  });
});
