import { describe, expect, it } from 'vitest';

import { parseTimestamp } from '../src/utils/timestamp';

describe('parseTimestamp', () => {
  it('returns undefined for non-string input', () => {
    expect(parseTimestamp(undefined)).toBeUndefined();
    expect(parseTimestamp(null)).toBeUndefined();
    expect(parseTimestamp(42)).toBeUndefined();
    expect(parseTimestamp({})).toBeUndefined();
  });

  it('returns undefined for empty or blank string', () => {
    expect(parseTimestamp('')).toBeUndefined();
    expect(parseTimestamp('   ')).toBeUndefined();
  });

  it('parses date-only string as UTC midnight', () => {
    const result = parseTimestamp('2024-03-15');
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe('2024-03-15T00:00:00.000Z');
  });

  it('parses ISO 8601 with Z suffix', () => {
    const result = parseTimestamp('2024-03-15T12:30:00Z');
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe('2024-03-15T12:30:00.000Z');
  });

  it('parses ISO 8601 without timezone as UTC', () => {
    const result = parseTimestamp('2024-03-15T12:30:00');
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBe(new Date('2024-03-15T12:30:00Z').getTime());
  });

  it('parses ISO 8601 with positive offset', () => {
    const result = parseTimestamp('2024-03-15T12:30:00+05:30');
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe('2024-03-15T07:00:00.000Z');
  });

  it('parses ISO 8601 with fractional seconds', () => {
    const result = parseTimestamp('2024-03-15T12:30:00.123Z');
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe('2024-03-15T12:30:00.123Z');
  });

  it('parses date with space separator instead of T', () => {
    const result = parseTimestamp('2024-03-15 12:30:00Z');
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe('2024-03-15T12:30:00.000Z');
  });

  it('returns undefined for completely invalid strings', () => {
    expect(parseTimestamp('not-a-date')).toBeUndefined();
    expect(parseTimestamp('hello world')).toBeUndefined();
  });
});
