import { describe, expect, it } from 'vitest';

import { computeRetryDelayMs, isRetryableErrorClass, DEFAULT_RETRY_POLICY } from '../src/config/retry-policy';

describe('isRetryableErrorClass', () => {
  it('returns false for undefined', () => {
    expect(isRetryableErrorClass(undefined)).toBe(false);
  });

  it('returns false for auth errors', () => {
    expect(isRetryableErrorClass('auth')).toBe(false);
    expect(isRetryableErrorClass('missing_key')).toBe(false);
  });

  it('returns true for retryable error classes', () => {
    expect(isRetryableErrorClass('timeout')).toBe(true);
    expect(isRetryableErrorClass('network')).toBe(true);
    expect(isRetryableErrorClass('server')).toBe(true);
  });
});

describe('computeRetryDelayMs', () => {
  it('returns a positive delay', () => {
    const delay = computeRetryDelayMs(1);
    expect(delay).toBeGreaterThan(0);
  });

  it('increases delay with attempt number', () => {
    const delays = Array.from({ length: 5 }, (_, i) =>
      computeRetryDelayMs(i + 1, { jitterRatio: 0 })
    );
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
  });

  it('respects maxDelayMs cap', () => {
    const delay = computeRetryDelayMs(100, { maxDelayMs: 1000, jitterRatio: 0 });
    expect(delay).toBeLessThanOrEqual(1000);
  });

  it('uses custom options', () => {
    const delay = computeRetryDelayMs(1, { baseDelayMs: 100, jitterRatio: 0 });
    expect(delay).toBe(100);
  });

  it('adds jitter within expected range', () => {
    const base = DEFAULT_RETRY_POLICY.baseDelayMs;
    const jitterRatio = DEFAULT_RETRY_POLICY.jitterRatio;
    const delay = computeRetryDelayMs(1);
    expect(delay).toBeGreaterThanOrEqual(base);
    expect(delay).toBeLessThanOrEqual(Math.round(base * (1 + jitterRatio)));
  });
});
