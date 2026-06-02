import { describe, expect, it } from 'vitest';

import {
  formatRelativeAgeFromHours,
  formatUtcForReport,
  formatWindowLabel,
  parseTimestamp
} from '../src/workflows/report/time-format';

describe('report time formatting', () => {
  it('parses timezone-naive timestamps as UTC', () => {
    expect(parseTimestamp('2026-02-07T03:37:12')?.toISOString()).toBe('2026-02-07T03:37:12.000Z');
    expect(parseTimestamp('2026-02-07 03:37:12.450000+0000')?.toISOString()).toBe('2026-02-07T03:37:12.450Z');
  });

  it('formats friendly UTC timestamps', () => {
    expect(formatUtcForReport('2026-02-23T10:09:00Z')).toBe('Feb 23, 2026 10:09 UTC');
    expect(formatUtcForReport('2026-02-23')).toBe('Feb 23, 2026 00:00 UTC');
  });

  it('keeps invalid timestamps unchanged for safe output', () => {
    expect(parseTimestamp('not-a-timestamp')).toBeUndefined();
    expect(formatUtcForReport('not-a-timestamp')).toBe('not-a-timestamp');
  });

  it('formats relative age from hour values', () => {
    expect(formatRelativeAgeFromHours(0)).toBe('just now');
    expect(formatRelativeAgeFromHours(1)).toBe('1h ago');
    expect(formatRelativeAgeFromHours(25)).toBe('1d 1h ago');
    expect(formatRelativeAgeFromHours(240)).toBe('10d ago');
  });

  it('formats window label wording', () => {
    expect(formatWindowLabel(1)).toBe('Last hour');
    expect(formatWindowLabel(24)).toBe('Last 24 hours');
    expect(formatWindowLabel(168)).toBe('Last week');
    expect(formatWindowLabel(720)).toBe('Last 30 days');
    expect(formatWindowLabel(0)).toBe('Last 24 hours');
  });
});
