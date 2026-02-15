import type { ConnectionErrorClass } from './connectivity';

export interface RetryPolicyOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitterRatio?: number;
}

export interface RetryState {
  attempts: number;
  retried: boolean;
  nextRetryMs?: number;
}

export const DEFAULT_RETRY_POLICY: Required<RetryPolicyOptions> = {
  maxAttempts: 3,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
  jitterRatio: 0.2
};

export function isRetryableErrorClass(kind: ConnectionErrorClass | undefined): boolean {
  if (!kind) {
    return false;
  }
  return !['auth', 'missing_key'].includes(kind);
}

export function computeRetryDelayMs(attempt: number, options: RetryPolicyOptions = {}): number {
  const merged = { ...DEFAULT_RETRY_POLICY, ...options };
  const expDelay = Math.min(merged.maxDelayMs, merged.baseDelayMs * 2 ** Math.max(0, attempt - 1));
  const jitter = expDelay * merged.jitterRatio * Math.random();
  return Math.round(expDelay + jitter);
}
