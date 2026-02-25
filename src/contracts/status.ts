import { z } from 'zod';

import type { ReadinessCheck } from '../config/readiness';
import { STATUS_SCHEMA_VERSION } from './versions';

export const StatusModeSchema = z.enum(['fast', 'full']);

const StatusProviderSchema = z.object({
  provider: z.string(),
  slotCount: z.number().int().nonnegative(),
  activeSlotId: z.string().optional(),
  activeSlotName: z.string().optional(),
  hasActiveSecret: z.boolean()
});

const StatusConnectivitySchema = z.object({
  state: z.string(),
  class: z.string().optional(),
  message: z.string(),
  retriable: z.boolean(),
  endpointKey: z.string().optional(),
  statusCode: z.number().int().optional()
});

const StatusReadinessSchema = z.object({
  state: z.string(),
  tenantId: z.string().optional(),
  activeTenant: z.unknown().optional(),
  missingItems: z.array(z.string()),
  recommendedActions: z.array(z.string()),
  providers: z.array(StatusProviderSchema),
  connectionState: z.string(),
  connectivity: StatusConnectivitySchema
});

export const StatusContractSchema = z.object({
  schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
  generatedAtUtc: z.string(),
  mode: StatusModeSchema,
  checkConnectivity: z.boolean(),
  readiness: StatusReadinessSchema
});

export type StatusMode = z.infer<typeof StatusModeSchema>;
export type StatusContractV1 = z.infer<typeof StatusContractSchema>;

export function buildStatusContract(args: {
  mode: StatusMode;
  checkConnectivity: boolean;
  readiness: ReadinessCheck;
}): StatusContractV1 {
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    mode: args.mode,
    checkConnectivity: args.checkConnectivity,
    readiness: args.readiness
  };
}
