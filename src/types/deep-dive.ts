import type { INSPECT_DEEP_DIVE_SCHEMA_VERSION } from '../contracts/versions';

export interface DeepDiveResult {
  schemaVersion: typeof INSPECT_DEEP_DIVE_SCHEMA_VERSION;
  generatedAtUtc: string;
  tenantId: string;
  tenantName?: string;
  windowHours: number;
  overviewMetrics?: {
    totalDevices: number;
    offlineDevices: number;
    offlinePct: number;
    totalIncidents: number;
    activeIncidents: number;
    activeIncidentPct: number;
    totalTickets: number;
    openTickets: number;
    statusMismatches: number;
  };
  summary: string[];
  topOfflineSpaces: Array<{ space: string; offlineDevices: number; shareOfOfflinePct: number }>;
  topIncidentDevices: Array<{ device: string; incidentCount: number; activeIncidents: number }>;
  activeIncidentAging: Array<{ device: string; space: string; ageHours: number; createdAtUtc: string }>;
  churnWindow: {
    incidents: number;
    devices: number;
    spaces: number;
    bySpace: Array<{ space: string; incidents: number }>;
    byDevice: Array<{ device: string; incidents: number }>;
  };
  ticketPosture: {
    openTickets: number;
    overlappingActiveIncidentDevices: number;
    oldestOpenTickets: Array<{ ticketId: string; title: string; ageHours: number; deviceId: string; createdAtUtc: string }>;
  };
  dataQuality: {
    statusMismatches: Array<{ device: string; status: string; stateStatus: string; lastSeen: string; space: string }>;
  };
}
