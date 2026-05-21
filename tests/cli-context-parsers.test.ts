import { describe, expect, it } from 'vitest';

import { parseCliOutputMode } from '../src/cli/cli-context';
import { formatBytes } from '../src/cli/format-bytes';
import { parseQueryJson, parseQueryString, parsePositiveIntegerOption, parsePositiveNumberOption } from '../src/cli/parse-options';

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

describe('parseQueryString', () => {
  it('returns empty object for undefined', () => {
    expect(parseQueryString(undefined)).toEqual({});
  });

  it('parses repeated flags and ampersand-separated pairs as strings', () => {
    expect(parseQueryString(['space_id=99592', 'path_includes=Regional Offices&name=South Wing'])).toEqual({
      space_id: '99592',
      path_includes: 'Regional Offices',
      name: 'South Wing'
    });
  });

  it('throws on duplicate keys', () => {
    expect(() => parseQueryString(['space_id=1&space_id=2'])).toThrow('Duplicate query parameter');
  });

  it('uses a null-prototype object for parsed query output', () => {
    const parsed = parseQueryString(['__proto__=polluted']);

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed.__proto__).toBe('polluted');
  });

  it('throws on invalid segments', () => {
    expect(() => parseQueryString(['space_id'])).toThrow('Use key=value');
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
