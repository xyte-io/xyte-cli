import { toProblemDetails } from '../client/errors';
import { XyteHttpError } from '../http/errors';
import type { XyteClient } from '../types/client';
import { isRecord } from '../utils/json';
import { CliUserError } from '../contracts/user-error';

export type EdgeTerminalState = 'success' | 'failed';
export type EdgePollState = 'pending' | EdgeTerminalState;

export interface EdgePollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  notInitiatedToleranceCount?: number;
  rateLimitMaxRetries?: number;
  rateLimitBaseBackoffMs?: number;
  rateLimitCeilingMs?: number;
}

export const DEFAULT_EDGE_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_EDGE_POLL_TIMEOUT_MS = 600_000;
export const DEFAULT_NOT_INITIATED_TOLERANCE = 3;
export const DEFAULT_RATE_LIMIT_MAX_RETRIES = 5;
export const DEFAULT_RATE_LIMIT_BASE_BACKOFF_MS = 500;
export const DEFAULT_RATE_LIMIT_CEILING_MS = 30_000;

export interface EdgePollResult {
  outcome: EdgeTerminalState | 'timeout';
  attempts: number;
  elapsedMs: number;
  lastState: EdgePollState | undefined;
  lastPayload: unknown;
}

export interface ProblemLike {
  status: number;
  detail: string;
}

export interface EdgeProbeProgress {
  attempts: number;
  elapsedMs: number;
  lastState?: EdgePollState;
  lastPayload?: unknown;
}

export class EdgeProbeAbortError extends Error {
  readonly problem: ProblemLike;
  constructor(message: string, problem: ProblemLike) {
    super(message);
    this.name = 'EdgeProbeAbortError';
    this.problem = problem;
  }
}

export class EdgeProbeRowError extends Error {
  readonly problem: ProblemLike;
  readonly progress: EdgeProbeProgress;
  constructor(message: string, problem: ProblemLike, progress: EdgeProbeProgress) {
    super(message);
    this.name = 'EdgeProbeRowError';
    this.problem = problem;
    this.progress = progress;
  }
}

function extractState(payload: unknown, fields: string[]): EdgePollState | undefined {
  if (!isRecord(payload)) return undefined;
  for (const field of fields) {
    const raw = payload[field];
    if (typeof raw === 'string') {
      const normalized = raw.trim().toLowerCase();
      if (normalized === 'pending' || normalized === 'success' || normalized === 'failed') {
        return normalized;
      }
    }
  }
  return undefined;
}

function notInitiatedMatches(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return normalized.includes('not initiated') || normalized.includes('no claim for');
}

function parseRetryAfterMs(headerValue: string | undefined, now: () => number): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  const asSeconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asSeconds) && asSeconds >= 0 && String(asSeconds) === trimmed) {
    return asSeconds * 1_000;
  }
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const delta = asDate - now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

function computeRateLimitBackoffMs(options: {
  headerValueMs: number | undefined;
  attempt: number;
  base: number;
  ceiling: number;
  random: () => number;
}): number {
  if (options.headerValueMs !== undefined) {
    return Math.min(options.headerValueMs, options.ceiling);
  }
  const exponential = options.base * 2 ** (options.attempt - 1);
  const jitter = options.random() * options.base;
  return Math.min(exponential + jitter, options.ceiling);
}

export interface EdgeProbePollArgs {
  client: XyteClient;
  tenantId: string;
  statusEndpointKey: string;
  statusResponseFields: string[];
  query: Record<string, string>;
  options?: EdgePollOptions;
  sleeper?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/**
 * Poll an async Edge endpoint (claim or ping) until it reports a terminal state or timeout.
 *
 * Handles case 12 (first poll can see 422 "not initiated for this device" before the platform
 * commits the async job) with a bounded tolerance counter, and case 11 (429 rate-limit) with
 * Retry-After-aware exponential backoff plus jitter, bounded by a per-row ceiling and retry
 * count. Treats any other 422/4xx as a row error. Treats 401 as an abort for the whole batch.
 */
export async function pollEdgeStatus(args: EdgeProbePollArgs): Promise<EdgePollResult> {
  const now = args.now ?? (() => Date.now());
  const sleeper = args.sleeper ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = args.random ?? Math.random;
  const intervalMs = args.options?.intervalMs ?? DEFAULT_EDGE_POLL_INTERVAL_MS;
  const timeoutMs = args.options?.timeoutMs ?? DEFAULT_EDGE_POLL_TIMEOUT_MS;
  const tolerance = args.options?.notInitiatedToleranceCount ?? DEFAULT_NOT_INITIATED_TOLERANCE;
  const rateLimitMaxRetries = args.options?.rateLimitMaxRetries ?? DEFAULT_RATE_LIMIT_MAX_RETRIES;
  const rateLimitBase = args.options?.rateLimitBaseBackoffMs ?? DEFAULT_RATE_LIMIT_BASE_BACKOFF_MS;
  const rateLimitCeiling = args.options?.rateLimitCeilingMs ?? DEFAULT_RATE_LIMIT_CEILING_MS;

  const startedAt = now();
  let attempts = 0;
  let notInitiatedSeen = 0;
  let rateLimitedSeen = 0;
  let lastState: EdgePollState | undefined;
  let lastPayload: unknown;

  while (now() - startedAt < timeoutMs) {
    attempts += 1;
    try {
      const response = await args.client.callWithMeta(args.statusEndpointKey, {
        tenantId: args.tenantId,
        query: args.query
      });
      lastPayload = response.data;
      lastState = extractState(response.data, args.statusResponseFields);
      if (lastState === 'success' || lastState === 'failed') {
        return {
          outcome: lastState,
          attempts,
          elapsedMs: now() - startedAt,
          lastState,
          lastPayload
        };
      }
    } catch (error) {
      const problem = toProblemDetails(error);
      if (problem.status === 401) {
        throw new EdgeProbeAbortError('Authorization failed; aborting run.', {
          status: problem.status,
          detail: problem.detail
        });
      }
      if (problem.status === 429) {
        if (rateLimitedSeen >= rateLimitMaxRetries) {
          throw new EdgeProbeRowError(
            problem.detail || 'Edge status probe rate-limited beyond retry ceiling.',
            { status: 429, detail: problem.detail },
            {
              attempts,
              elapsedMs: now() - startedAt,
              lastState,
              lastPayload
            }
          );
        }
        rateLimitedSeen += 1;
        const retryAfterMs =
          error instanceof XyteHttpError
            ? parseRetryAfterMs(error.headers?.['retry-after'], now)
            : undefined;
        const backoffMs = computeRateLimitBackoffMs({
          headerValueMs: retryAfterMs,
          attempt: rateLimitedSeen,
          base: rateLimitBase,
          ceiling: rateLimitCeiling,
          random
        });
        const remainingMs = timeoutMs - (now() - startedAt);
        if (remainingMs <= 0) break;
        await sleeper(Math.min(backoffMs, remainingMs));
        continue;
      }
      if (problem.status === 422 && notInitiatedMatches(problem.detail) && notInitiatedSeen < tolerance) {
        notInitiatedSeen += 1;
      } else {
        throw new EdgeProbeRowError(problem.detail || 'Edge status probe failed.', {
          status: problem.status ?? 500,
          detail: problem.detail
        }, {
          attempts,
          elapsedMs: now() - startedAt,
          lastState,
          lastPayload
        });
      }
    }
    if (now() - startedAt + intervalMs >= timeoutMs) {
      break;
    }
    await sleeper(intervalMs);
  }

  return {
    outcome: 'timeout',
    attempts,
    elapsedMs: now() - startedAt,
    lastState,
    lastPayload
  };
}

export function parsePositiveInt(raw: string | undefined, label: string): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new CliUserError({ summary: `${label} must be a positive integer, got "${raw}".` });
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliUserError({ summary: `${label} must be a positive integer, got "${raw}".` });
  }
  return parsed;
}
