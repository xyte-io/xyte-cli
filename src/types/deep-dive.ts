import { z } from 'zod';

import { INSPECT_DEEP_DIVE_SCHEMA_VERSION } from '../contracts/versions';

const DeepDiveTopOfflineSpaceSchema = z.object({
  space: z.string(),
  offlineDevices: z.number(),
  shareOfOfflinePct: z.number()
});

const DeepDiveTopIncidentDeviceSchema = z.object({
  device: z.string(),
  incidentCount: z.number(),
  activeIncidents: z.number()
});

const DeepDiveIncidentAgingSchema = z.object({
  device: z.string(),
  space: z.string(),
  ageHours: z.number(),
  createdAtUtc: z.string()
});

const DeepDiveChurnEntrySchema = z.object({
  space: z.string(),
  incidents: z.number()
});

const DeepDiveDeviceChurnEntrySchema = z.object({
  device: z.string(),
  incidents: z.number()
});

const DeepDiveOldestTicketSchema = z.object({
  ticketId: z.string(),
  title: z.string(),
  ageHours: z.number(),
  deviceId: z.string(),
  createdAtUtc: z.string()
});

const DeepDiveStatusMismatchSchema = z.object({
  device: z.string(),
  status: z.string(),
  stateStatus: z.string(),
  lastSeen: z.string(),
  space: z.string()
});

const DeepDiveOverviewMetricsSchema = z.object({
  totalDevices: z.number(),
  offlineDevices: z.number(),
  offlinePct: z.number(),
  totalIncidents: z.number(),
  activeIncidents: z.number(),
  activeIncidentPct: z.number(),
  totalTickets: z.number(),
  openTickets: z.number(),
  statusMismatches: z.number()
});

export const DeepDiveResultSchema = z.object({
  schemaVersion: z.literal(INSPECT_DEEP_DIVE_SCHEMA_VERSION),
  generatedAtUtc: z.string(),
  tenantId: z.string(),
  tenantName: z.string().optional(),
  windowHours: z.number(),
  overviewMetrics: DeepDiveOverviewMetricsSchema.optional(),
  summary: z.array(z.string()),
  topOfflineSpaces: z.array(DeepDiveTopOfflineSpaceSchema),
  topIncidentDevices: z.array(DeepDiveTopIncidentDeviceSchema),
  activeIncidentAging: z.array(DeepDiveIncidentAgingSchema),
  churnWindow: z.object({
    incidents: z.number(),
    devices: z.number(),
    spaces: z.number(),
    bySpace: z.array(DeepDiveChurnEntrySchema),
    byDevice: z.array(DeepDiveDeviceChurnEntrySchema)
  }),
  ticketPosture: z.object({
    openTickets: z.number(),
    overlappingActiveIncidentDevices: z.number(),
    oldestOpenTickets: z.array(DeepDiveOldestTicketSchema)
  }),
  dataQuality: z.object({
    statusMismatches: z.array(DeepDiveStatusMismatchSchema)
  })
});

export type DeepDiveResult = z.infer<typeof DeepDiveResultSchema>;
