import { describe, expect, it } from 'vitest';

import { parseCliOutputMode } from '../src/cli/cli-context';
import {
  parseQueryJson,
  parsePositiveIntegerOption,
  parsePositiveNumberOption,
  formatBytes
} from '../src/cli/parse-options';

describe('parseQueryJson', () => {
  it('returns empty object for undefined', () => {
    expect(parseQueryJson(undefined)).toEqual({});
  });

  it('parses scalar values', () => {
    expect(parseQueryJson('{"a":"1","b":2,"c":true,"d":null}')).toEqual({
      a: '1',
      b: 2,
      c: true,
      d: null
    });
  });

  it('throws on non-scalar values', () => {
    expect(() => parseQueryJson('{"a":[1,2]}')).toThrow('must be scalar');
  });
});

describe('parseCliOutputMode', () => {
  it('returns undefined for undefined input', () => {
    expect(parseCliOutputMode(undefined)).toBeUndefined();
  });

  it('parses valid modes case-insensitively', () => {
    expect(parseCliOutputMode('json')).toBe('json');
    expect(parseCliOutputMode('TEXT')).toBe('text');
    expect(parseCliOutputMode(' Auto ')).toBe('auto');
  });

  it('throws on invalid mode', () => {
    expect(() => parseCliOutputMode('xml')).toThrow('Invalid output mode');
  });
});

describe('parsePositiveIntegerOption', () => {
  it('returns fallback for undefined', () => {
    expect(parsePositiveIntegerOption(undefined, 10, 'test')).toBe(10);
  });

  it('parses valid positive integers', () => {
    expect(parsePositiveIntegerOption('5', 10, 'test')).toBe(5);
    expect(parsePositiveIntegerOption('1', 10, 'test')).toBe(1);
  });

  it('throws on non-positive values', () => {
    expect(() => parsePositiveIntegerOption('0', 10, 'count')).toThrow('Invalid count');
    expect(() => parsePositiveIntegerOption('-1', 10, 'count')).toThrow('Invalid count');
  });

  it('throws on non-numeric strings', () => {
    expect(() => parsePositiveIntegerOption('abc', 10, 'count')).toThrow('Invalid count');
  });
});

describe('parsePositiveNumberOption', () => {
  it('returns fallback for undefined', () => {
    expect(parsePositiveNumberOption(undefined, 1.5, 'rate')).toBe(1.5);
  });

  it('parses valid positive numbers', () => {
    expect(parsePositiveNumberOption('2.5', 1, 'rate')).toBe(2.5);
  });

  it('throws on non-positive values', () => {
    expect(() => parsePositiveNumberOption('0', 1, 'rate')).toThrow('positive number');
    expect(() => parsePositiveNumberOption('-1', 1, 'rate')).toThrow('positive number');
  });
});

describe('formatBytes', () => {
  it('formats bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats kilobytes', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('formats megabytes', () => {
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
