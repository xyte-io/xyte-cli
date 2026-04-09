import type { INSPECT_FLEET_SCHEMA_VERSION } from '../contracts/versions';
import type { InspectProviderScope } from './settings-enums';

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

export interface FleetInspectResult {
  schemaVersion: typeof INSPECT_FLEET_SCHEMA_VERSION;
  generatedAtUtc: string;
  tenantId: string;
  totals: {
    devices: number;
    spaces: number;
    incidents: number;
    tickets: number;
  };
  status: {
    devices: StatusCounts;
    incidents: StatusCounts;
    tickets: StatusCounts;
    spaces: StatusCounts;
  };
  highlights: {
    offlineDevices: number;
    offlinePct: number;
    activeIncidents: number;
    activeIncidentPct: number;
    openTickets: number;
  };
}
