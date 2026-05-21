import { z } from 'zod';

import type { InspectProviderScope } from './settings-enums';

export const INSPECT_FLEET_SCHEMA_VERSION = 'xyte.inspect.fleet.v1' as const;

export interface StatusCounts {
  [key: string]: number;
}

export type ResolvedInspectProviderScope = Exclude<InspectProviderScope, 'auto'>;

export interface FleetSnapshot {
  generatedAtUtc: string;
  tenantId: string;
  tenantName?: string;
  providerScope?: ResolvedInspectProviderScope;
  devices: unknown[];
  spaces: unknown[];
  incidents: unknown[];
  tickets: unknown[];
  partnerEnrichment?: PartnerEnrichmentSnapshot;
}

export interface PartnerEndpointOutcome {
  attempted: number;
  succeeded: number;
  failed: number;
  lastError?: string;
}

export interface PartnerEnrichmentSnapshot {
  sampledDeviceCount: number;
  totalDeviceCount: number;
  endpointAvailability: {
    deviceInfo: PartnerEndpointOutcome;
    commands: PartnerEndpointOutcome;
    telemetries: PartnerEndpointOutcome;
    stateHistory: PartnerEndpointOutcome;
  };
  modelDistribution: StatusCounts;
  firmwareDistribution: StatusCounts;
  lastSeenRecency: StatusCounts;
  commandPosture: StatusCounts;
  telemetryCoverage: {
    withTelemetries: number;
    freshWithinWindow: number;
  };
  stateHistoryCoverage: {
    withHistory: number;
    totalEntries: number;
  };
}

const StatusCountsSchema = z.record(z.string(), z.number());

export const FleetInspectResultSchema = z.object({
  schemaVersion: z.literal(INSPECT_FLEET_SCHEMA_VERSION),
  generatedAtUtc: z.string(),
  tenantId: z.string(),
  totals: z.object({
    devices: z.number(),
    spaces: z.number(),
    incidents: z.number(),
    tickets: z.number()
  }),
  status: z.object({
    devices: StatusCountsSchema,
    incidents: StatusCountsSchema,
    tickets: StatusCountsSchema,
    spaces: StatusCountsSchema
  }),
  highlights: z.object({
    offlineDevices: z.number(),
    offlinePct: z.number(),
    activeIncidents: z.number(),
    activeIncidentPct: z.number(),
    openTickets: z.number()
  })
});

export type FleetInspectResult = z.infer<typeof FleetInspectResultSchema>;
