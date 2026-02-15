import { z } from 'zod';

import { CALL_ENVELOPE_SCHEMA_VERSION } from './versions';
import type { ProblemDetails } from './problem';

export const CallGuardSchema = z.object({
  allowWrite: z.boolean(),
  confirm: z.string().optional()
});

export const CallEnvelopeResponseSchema = z.object({
  status: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  retryCount: z.number().int().nonnegative(),
  data: z.unknown()
});

export const CallEnvelopeRequestSchema = z.object({
  path: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).default({}),
  body: z.unknown().optional()
});

export const CallEnvelopeSchema = z.object({
  schemaVersion: z.literal(CALL_ENVELOPE_SCHEMA_VERSION),
  timestamp: z.string(),
  requestId: z.string(),
  tenantId: z.string().optional(),
  endpointKey: z.string(),
  method: z.string(),
  guard: CallGuardSchema,
  request: CallEnvelopeRequestSchema,
  response: CallEnvelopeResponseSchema.optional(),
  error: z
    .object({
      type: z.string(),
      title: z.string(),
      status: z.number().int().optional(),
      detail: z.string(),
      instance: z.string().optional(),
      xyteCode: z.string(),
      retriable: z.boolean()
    })
    .optional()
});

export type CallEnvelopeV1 = z.infer<typeof CallEnvelopeSchema>;

export interface BuildCallEnvelopeArgs {
  requestId: string;
  tenantId?: string;
  endpointKey: string;
  method: string;
  guard: {
    allowWrite: boolean;
    confirm?: string;
  };
  request: {
    path?: Record<string, string | number>;
    query?: Record<string, string | number | boolean | null | undefined>;
    body?: unknown;
  };
  response?: {
    status: number;
    durationMs: number;
    retryCount: number;
    data: unknown;
  };
  error?: ProblemDetails;
}

export function buildCallEnvelope(args: BuildCallEnvelopeArgs): CallEnvelopeV1 {
  const query: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(args.request.query ?? {})) {
    if (value === undefined) {
      continue;
    }
    query[key] = value;
  }

  return {
    schemaVersion: CALL_ENVELOPE_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    requestId: args.requestId,
    tenantId: args.tenantId,
    endpointKey: args.endpointKey,
    method: args.method,
    guard: {
      allowWrite: args.guard.allowWrite,
      confirm: args.guard.confirm
    },
    request: {
      path: args.request.path ?? {},
      query,
      body: args.request.body
    },
    response: args.response,
    error: args.error
  };
}
