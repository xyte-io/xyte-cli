import { z } from 'zod';

import type { ProblemDetails } from './problem';
import { WATCH_FRAME_SCHEMA_VERSION } from './versions';

export const DEFAULT_WATCH_PROFILE = 'incidents-active' as const;
export const WatchProfileSchema = z.literal(DEFAULT_WATCH_PROFILE);
const WatchEventTypeSchema = z.enum(['snapshot', 'delta', 'heartbeat', 'error']);

const WatchDeltaEntrySchema = z.object({
  id: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional()
});

export const WatchDeltaSchema = z.object({
  added: z.array(WatchDeltaEntrySchema),
  removed: z.array(WatchDeltaEntrySchema),
  updated: z.array(WatchDeltaEntrySchema)
});

const WatchSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
  changed: z.boolean()
});

const WatchErrorSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int().optional(),
  detail: z.string(),
  instance: z.string().optional(),
  xyteCode: z.string(),
  retriable: z.boolean(),
  upstream: z.unknown().optional()
});

export const WatchFrameSchema = z.object({
  schemaVersion: z.literal(WATCH_FRAME_SCHEMA_VERSION),
  timestamp: z.string(),
  runId: z.string(),
  sequence: z.number().int().nonnegative(),
  pollIndex: z.number().int().positive(),
  intervalMs: z.number().int().min(250),
  profile: WatchProfileSchema,
  endpointKey: z.string(),
  tenantId: z.string().optional(),
  eventType: WatchEventTypeSchema,
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  summary: WatchSummarySchema,
  items: z.array(z.unknown()).optional(),
  delta: WatchDeltaSchema.optional(),
  error: WatchErrorSchema.optional()
});

export type WatchProfile = z.infer<typeof WatchProfileSchema>;
type WatchEventType = z.infer<typeof WatchEventTypeSchema>;
export type WatchDelta = z.infer<typeof WatchDeltaSchema>;
type WatchSummary = z.infer<typeof WatchSummarySchema>;
export type WatchFrameV1 = z.infer<typeof WatchFrameSchema>;

interface BuildWatchFrameArgs {
  runId: string;
  sequence: number;
  pollIndex: number;
  intervalMs: number;
  profile: WatchProfile;
  endpointKey: string;
  tenantId?: string;
  eventType: WatchEventType;
  query?: Record<string, string | number | boolean | null | undefined>;
  summary: WatchSummary;
  items?: unknown[];
  delta?: WatchDelta;
  error?: ProblemDetails;
  timestamp?: string;
}

export function buildWatchFrame(args: BuildWatchFrameArgs): WatchFrameV1 {
  const query: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(args.query ?? {})) {
    if (value === undefined) {
      continue;
    }
    query[key] = value;
  }

  return {
    schemaVersion: WATCH_FRAME_SCHEMA_VERSION,
    timestamp: args.timestamp ?? new Date().toISOString(),
    runId: args.runId,
    sequence: args.sequence,
    pollIndex: args.pollIndex,
    intervalMs: args.intervalMs,
    profile: args.profile,
    endpointKey: args.endpointKey,
    tenantId: args.tenantId,
    eventType: args.eventType,
    query,
    summary: args.summary,
    items: args.items,
    delta: args.delta,
    error: args.error
  };
}
