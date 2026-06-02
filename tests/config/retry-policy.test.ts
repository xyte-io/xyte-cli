import { describe, expect, it } from 'vitest';

import {
  computeRetryDelayMs,
  DEFAULT_RETRY_POLICY,
  isRetryableErrorClass
} from '../../src/config/retry-policy';

describe('isRetryableErrorClass', () => {
  it('returns false for undefined', () => {
    expect(isRetryableErrorClass(undefined)).toBe(false);
  });

  it('returns false for auth errors', () => {
    expect(isRetryableErrorClass('auth')).toBe(false);
  });

  it('returns false for missing_key errors', () => {
    expect(isRetryableErrorClass('missing_key')).toBe(false);
  });

  it('returns true for network errors', () => {
    expect(isRetryableErrorClass('network')).toBe(true);
  });

  it('returns true for timeout errors', () => {
    expect(isRetryableErrorClass('timeout')).toBe(true);
  });

  it('returns true for rate_limit errors', () => {
    expect(isRetryableErrorClass('rate_limit')).toBe(true);
  });
});

describe('computeRetryDelayMs', () => {
  it('returns a positive delay for attempt 1', () => {
    const delay = computeRetryDelayMs(1);
    expect(delay).toBeGreaterThanOrEqual(DEFAULT_RETRY_POLICY.baseDelayMs);
  });

  it('increases delay exponentially with attempt number', () => {
    const delay1 = computeRetryDelayMs(1, { jitterRatio: 0 });
    const delay2 = computeRetryDelayMs(2, { jitterRatio: 0 });
    const delay3 = computeRetryDelayMs(3, { jitterRatio: 0 });
    expect(delay2).toBeGreaterThan(delay1);
    expect(delay3).toBeGreaterThan(delay2);
  });

  it('caps delay at maxDelayMs', () => {
    const delay = computeRetryDelayMs(100, { maxDelayMs: 500, jitterRatio: 0 });
    expect(delay).toBeLessThanOrEqual(500);
  });

  it('respects custom baseDelayMs', () => {
    const delay = computeRetryDelayMs(1, { baseDelayMs: 1000, jitterRatio: 0 });
    expect(delay).toBe(1000);
  });
});
