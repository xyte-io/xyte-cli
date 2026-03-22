import { describe, expect, it } from 'vitest';

import { firstText, safeString } from '../src/workflows/fleet-insights-loaders';

describe('safeString', () => {
  it('returns string representation for primitives', () => {
    expect(safeString('hello')).toBe('hello');
    expect(safeString(42)).toBe('42');
    expect(safeString(true)).toBe('true');
    expect(safeString(0)).toBe('0');
    expect(safeString('')).toBe('');
  });

  it('returns n/a for null and undefined', () => {
    expect(safeString(null)).toBe('n/a');
    expect(safeString(undefined)).toBe('n/a');
  });

  it('stringifies objects', () => {
    expect(safeString({ key: 'value' })).toBe('[object Object]');
  });
});

describe('firstText', () => {
  it('returns the first non-empty string', () => {
    expect(firstText('hello', 'world')).toBe('hello');
    expect(firstText(undefined, 'world')).toBe('world');
    expect(firstText(null, '', 'third')).toBe('third');
  });

  it('trims whitespace', () => {
    expect(firstText('  trimmed  ')).toBe('trimmed');
  });

  it('skips blank strings', () => {
    expect(firstText('', '  ', 'valid')).toBe('valid');
  });

  it('returns undefined when all values are empty or non-string', () => {
    expect(firstText()).toBeUndefined();
    expect(firstText(undefined, null, 42, '')).toBeUndefined();
    expect(firstText('', '  ')).toBeUndefined();
  });

  it('skips non-string values', () => {
    expect(firstText(42, true, 'text')).toBe('text');
  });
});
