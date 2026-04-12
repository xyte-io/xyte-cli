import { z } from 'zod';

import type { SecretProvider, TenantProfile } from '../types/profile';
import { SUPPORTED_SECRET_PROVIDERS } from '../types/profile';
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

const CONNECTION_STATES = ['connected', 'auth_required', 'missing_key', 'network_error', 'timeout', 'rate_limited', 'unknown_error', 'not_checked'] as const;

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
  state: z.enum(CONNECTION_STATES),
  class: z.enum(['auth', 'missing_key', 'network', 'timeout', 'rate_limit', 'unknown']).optional(),
  message: z.string(),
  retriable: z.boolean(),
  endpointKey: z.string().optional(),
  statusCode: z.number().int().optional()
});

const StatusReadinessSchema = z.object({
  state: z.enum(['ready', 'needs_setup', 'degraded']),
  tenantId: z.string().optional(),
  activeTenant: z.object({
    id: z.string(),
    name: z.string(),
    hubBaseUrl: z.string().optional(),
    entryBaseUrl: z.string().optional(),
    apiProvider: z.enum(SUPPORTED_SECRET_PROVIDERS as unknown as [string, ...string[]]).optional(),
    keyRegistry: z.object({
      slots: z.array(z.object({
        slotId: z.string(),
        provider: z.enum(SUPPORTED_SECRET_PROVIDERS as unknown as [string, ...string[]]),
        name: z.string(),
        fingerprint: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
        lastValidatedAt: z.string().optional()
      })),
      activeSlotByProvider: z.record(z.string(), z.string())
    }),
    createdAt: z.string(),
    updatedAt: z.string()
  }).optional(),
  missingItems: z.array(z.string()),
  recommendedActions: z.array(z.string()),
  providers: z.array(StatusProviderSchema),
  connectionState: z.enum(CONNECTION_STATES),
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
