import { z } from 'zod';

import type { SecretProvider, TenantProfile } from '../types/profile';
import { STATUS_SCHEMA_VERSION } from './versions';

export type ConnectionErrorClass = 'auth' | 'missing_key' | 'network' | 'timeout' | 'rate_limit' | 'unknown';

export type ConnectionState =
  | 'connected'
  | 'auth_required'
  | 'missing_key'
  | 'network_error'
  | 'timeout'
  | 'rate_limited'
  | 'unknown_error'
  | 'not_checked';

export interface ConnectivityResult {
  state: ConnectionState;
  class?: ConnectionErrorClass;
  message: string;
  retriable: boolean;
  endpointKey?: string;
  statusCode?: number;
}

export type ReadinessState = 'ready' | 'needs_setup' | 'degraded';

export interface ProviderReadiness {
  provider: SecretProvider;
  slotCount: number;
  activeSlotId?: string;
  activeSlotName?: string;
  hasActiveSecret: boolean;
}

export interface ReadinessCheck {
  state: ReadinessState;
  activeTenant?: TenantProfile;
  tenantId?: string;
  missingItems: string[];
  recommendedActions: string[];
  providers: ProviderReadiness[];
  connectionState: ConnectivityResult['state'];
  connectivity: ConnectivityResult;
}

const StatusModeSchema = z.enum(['fast', 'full']);

const StatusProviderSchema = z.object({
  provider: z.string(),
  slotCount: z.number().int().nonnegative(),
  activeSlotId: z.string().optional(),
  activeSlotName: z.string().optional(),
  hasActiveSecret: z.boolean()
});

const StatusConnectivitySchema = z.object({
  state: z.enum(['connected', 'auth_required', 'missing_key', 'network_error', 'timeout', 'rate_limited', 'unknown_error', 'not_checked']),
  class: z.enum(['auth', 'missing_key', 'network', 'timeout', 'rate_limit', 'unknown']).optional(),
  message: z.string(),
  retriable: z.boolean(),
  endpointKey: z.string().optional(),
  statusCode: z.number().int().optional()
});

const StatusReadinessSchema = z.object({
  state: z.enum(['ready', 'needs_setup', 'degraded']),
  tenantId: z.string().optional(),
  activeTenant: z.unknown().optional(),
  missingItems: z.array(z.string()),
  recommendedActions: z.array(z.string()),
  providers: z.array(StatusProviderSchema),
  connectionState: z.enum(['connected', 'auth_required', 'missing_key', 'network_error', 'timeout', 'rate_limited', 'unknown_error', 'not_checked']),
  connectivity: StatusConnectivitySchema
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- used for z.infer type derivation
const StatusContractSchema = z.object({
  schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
  generatedAtUtc: z.string(),
  mode: StatusModeSchema,
  checkConnectivity: z.boolean(),
  readiness: StatusReadinessSchema
});

export type StatusMode = z.infer<typeof StatusModeSchema>;
type StatusContractV1 = z.infer<typeof StatusContractSchema>;

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
