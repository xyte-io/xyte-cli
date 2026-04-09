import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import { asRecord, safeString } from '../utils/json';
import {
  DEVICE_MATCH_SCHEMA_VERSION,
  INSPECT_DEEP_DIVE_SCHEMA_VERSION,
  INSPECT_FLEET_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  UTILITY_BATCH_SCHEMA_VERSION
} from '../contracts/versions';
import { parseTimestamp } from './report/time-format';
import { parseMoveVerificationResult } from './verify-device-moves';

export { collectFleetSnapshot, InspectProviderScopeError } from './fleet-insights-loaders';
export { formatFleetInspectAscii, formatDeepDiveAscii, formatDeepDiveMarkdown } from './fleet-insights-format';
import { formatDeepDiveMarkdown } from './fleet-insights-format';

export type { FleetSnapshot, FleetInspectResult } from '../types/fleet-inspect';
import type { StatusCounts, FleetSnapshot, FleetInspectResult } from '../types/fleet-inspect';

export type { DeepDiveResult } from '../types/deep-dive';
import type { DeepDiveResult } from '../types/deep-dive';

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

const DeepDiveResultSchema = z.object({
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

import { DeviceMatchResultSchema } from './match';
import { UtilityBatchResultSchema } from './utility-batch';

const DeviceMoveBatchReportSchema = UtilityBatchResultSchema.extend({
  command: z.literal('device.move')
});

interface FleetReportResult {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  generatedAtUtc: string;
  tenantId: string;
  format: 'markdown' | 'pdf';
  outputPath: string;
  includeSensitive: boolean;
}

export type OpsReportInput =
  | DeepDiveResult
  | z.infer<typeof DeviceMatchResultSchema>
  | z.infer<typeof DeviceMoveBatchReportSchema>;

function toCounter(items: string[]): StatusCounts {
  const counter: StatusCounts = {};
  for (const item of items) {
    counter[item] = (counter[item] ?? 0) + 1;
  }
  return counter;
}

function pct(count: number, total: number): number {
  if (!total) {
    return 0;
  }
  return Number(((count * 100) / total).toFixed(1));
}

function ageHours(createdAt: unknown): number | undefined {
  const parsed = parseTimestamp(createdAt);
  if (!parsed) {
    return undefined;
  }
  const now = Date.now();
  return Math.max(0, Math.round((now - parsed.getTime()) / 3_600_000));
}

function topEntries(counter: Record<string, number>, limit = 10): Array<[string, number]> {
  return Object.entries(counter)
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit);
}

function safeSpacePath(value: unknown): string {
  const r = asRecord(value);
  const space = asRecord(r.space);
  return safeString(r.space_tree_path_name ?? space.full_path ?? space.name ?? r.space_id ?? 'unknown');
}

function safeDeviceName(value: unknown): string {
  const r = asRecord(value);
  const device = asRecord(r.device);
  return safeString(r.device_name ?? r.name ?? device.name ?? r.device_id ?? 'unknown');
}

function totalCount(counter: StatusCounts): number {
  return Object.values(counter).reduce((sum, value) => sum + value, 0);
}

function formatDistribution(counter: StatusCounts, sampleSize: number, maxEntries = 4): string | undefined {
  const entries = topEntries(counter, maxEntries);
  if (!entries.length) {
    return undefined;
  }
  const visible = entries.map(([label, count]) => `${label}=${count}`);
  const shownTotal = entries.reduce((sum, [, count]) => sum + count, 0);
  const remaining = totalCount(counter) - shownTotal;
  if (remaining > 0) {
    visible.push(`other=${remaining}`);
  }
  return `${visible.join(', ')} (sampled ${sampleSize})`;
}

function formatCommandPosture(counter: StatusCounts, sampleSize: number): string | undefined {
  const entries = topEntries(counter, 6);
  if (!entries.length) {
    return undefined;
  }
  return `${entries.map(([status, count]) => `${status}=${count}`).join(', ')} (sampled ${sampleSize})`;
}

function formatRecency(counter: StatusCounts, sampleSize: number): string | undefined {
  if (totalCount(counter) === 0) {
    return undefined;
  }
  const ordered = ['<=1h', '1h-24h', '1d-7d', '>7d', 'unknown'].map((bucket) => `${bucket}=${counter[bucket] ?? 0}`);
  return `${ordered.join(', ')} (sampled ${sampleSize})`;
}

function fieldCounter(items: unknown[], field: string): Record<string, number> {
  return toCounter(
    items.map((item) => {
      const r = asRecord(item);
      return safeString(typeof r[field] === 'string' ? r[field] : 'unknown');
    })
  );
}

function buildPartnerSummaryLines(snapshot: FleetSnapshot): string[] {
  if (
    snapshot.providerScope !== 'partner' ||
    !snapshot.partnerEnrichment ||
    snapshot.partnerEnrichment.sampledDeviceCount === 0
  ) {
    return [];
  }

  const enrichment = snapshot.partnerEnrichment;
  const sampled = enrichment.sampledDeviceCount;
  const lines: string[] = [];

  const modelDistribution = formatDistribution(enrichment.modelDistribution, sampled);
  if (modelDistribution) {
    lines.push(`Partner model distribution: ${modelDistribution}.`);
  }

  const firmwareDistribution = formatDistribution(enrichment.firmwareDistribution, sampled);
  if (firmwareDistribution) {
    lines.push(`Partner firmware distribution: ${firmwareDistribution}.`);
  }

  const recency = formatRecency(enrichment.lastSeenRecency, sampled);
  if (recency) {
    lines.push(`Partner last-seen recency: ${recency}.`);
  }

  const commandPosture = formatCommandPosture(enrichment.commandPosture, sampled);
  if (commandPosture) {
    lines.push(`Partner command posture: ${commandPosture}.`);
  }

  if (enrichment.endpointAvailability.telemetries.succeeded > 0) {
    lines.push(
      `Partner telemetry coverage: ${enrichment.telemetryCoverage.withTelemetries}/${sampled} devices with telemetries, ${enrichment.telemetryCoverage.freshWithinWindow}/${sampled} fresh <=24h.`
    );
  }

  if (enrichment.endpointAvailability.stateHistory.succeeded > 0) {
    lines.push(
      `Partner state history coverage: ${enrichment.stateHistoryCoverage.withHistory}/${sampled} devices with history, ${enrichment.stateHistoryCoverage.totalEntries} entries.`
    );
  }

  return lines;
}

export function buildFleetInspect(snapshot: FleetSnapshot): FleetInspectResult {
  const deviceStatus = fieldCounter(snapshot.devices, 'status');
  const incidentStatus = fieldCounter(snapshot.incidents, 'status');
  const ticketStatus = fieldCounter(snapshot.tickets, 'status');
  const spaceTypes = fieldCounter(snapshot.spaces, 'space_type');

  const offlineDevices = deviceStatus.offline ?? 0;
  const activeIncidents = incidentStatus.active ?? 0;
  const openTickets = ticketStatus.open ?? 0;

  return {
    schemaVersion: INSPECT_FLEET_SCHEMA_VERSION,
    generatedAtUtc: snapshot.generatedAtUtc,
    tenantId: snapshot.tenantId,
    totals: {
      devices: snapshot.devices.length,
      spaces: snapshot.spaces.length,
      incidents: snapshot.incidents.length,
      tickets: snapshot.tickets.length
    },
    status: {
      devices: deviceStatus,
      incidents: incidentStatus,
      tickets: ticketStatus,
      spaces: spaceTypes
    },
    highlights: {
      offlineDevices,
      offlinePct: pct(offlineDevices, snapshot.devices.length),
      activeIncidents,
      activeIncidentPct: pct(activeIncidents, snapshot.incidents.length),
      openTickets
    }
  };
}

export function buildDeepDive(snapshot: FleetSnapshot, windowHours = 24): DeepDiveResult {
  const offlineDevices = snapshot.devices.filter((item) => safeString(asRecord(item).status) === 'offline');
  const activeIncidents = snapshot.incidents.filter((item) => safeString(asRecord(item).status) === 'active');
  const openTickets = snapshot.tickets.filter((item) => safeString(asRecord(item).status) === 'open');

  const offlineBySpace = toCounter(offlineDevices.map((item) => safeSpacePath(item)));
  const incidentsByDevice = toCounter(snapshot.incidents.map((item) => safeDeviceName(item)));
  const activeByDevice = toCounter(activeIncidents.map((item) => safeDeviceName(item)));

  const incidentsWithAge = snapshot.incidents.map((item) => ({ item, age: ageHours(asRecord(item).created_at) }));
  const recentIncidents = incidentsWithAge
    .filter((entry): entry is { item: unknown; age: number } => entry.age !== undefined && entry.age <= windowHours)
    .map((entry) => entry.item);
  const unknownIncidentAgeCount = incidentsWithAge.filter((entry) => entry.age === undefined).length;
  const recentSpace = toCounter(recentIncidents.map((item) => safeSpacePath(item)));
  const recentDevice = toCounter(recentIncidents.map((item) => safeDeviceName(item)));

  const activeDeviceIds = new Set(
    activeIncidents.map((item) => {
      const r = asRecord(item);
      return safeString(r.device_id ?? asRecord(r.device).id);
    })
  );
  const overlapDevices = new Set(
    openTickets.map((item) => safeString(asRecord(item).device_id)).filter((id) => activeDeviceIds.has(id))
  );

  const mismatches = snapshot.devices
    .map((item) => {
      const r = asRecord(item);
      const nestedState = asRecord(r.state).status;
      if (nestedState === undefined) {
        return undefined;
      }
      const topLevel = safeString(r.status);
      const nested = safeString(nestedState);
      if (topLevel === nested) {
        return undefined;
      }
      return {
        device: safeDeviceName(item),
        status: topLevel,
        stateStatus: nested,
        lastSeen: safeString(r.last_seen_at),
        space: safeSpacePath(item)
      };
    })
    .filter((item): item is { device: string; status: string; stateStatus: string; lastSeen: string; space: string } =>
      Boolean(item)
    )
    .sort((a, b) => a.device.localeCompare(b.device));

  const topOfflineSpaces = topEntries(offlineBySpace, 10).map(([space, count]) => ({
    space,
    offlineDevices: count,
    shareOfOfflinePct: pct(count, offlineDevices.length)
  }));

  const topIncidentDevices = topEntries(incidentsByDevice, 10).map(([device, count]) => ({
    device,
    incidentCount: count,
    activeIncidents: activeByDevice[device] ?? 0
  }));

  const activeIncidentAging = activeIncidents
    .map((item) => ({ item, age: ageHours(asRecord(item).created_at) }))
    .filter((entry): entry is { item: unknown; age: number } => entry.age !== undefined)
    .map((entry) => ({
      device: safeDeviceName(entry.item),
      space: safeSpacePath(entry.item),
      ageHours: entry.age,
      createdAtUtc: safeString(asRecord(entry.item).created_at)
    }))
    .sort((a, b) => b.ageHours - a.ageHours);

  const ticketsWithAge = openTickets.map((item) => ({ item, age: ageHours(asRecord(item).created_at) }));
  const oldestOpenTickets = ticketsWithAge
    .filter((entry): entry is { item: unknown; age: number } => entry.age !== undefined)
    .map((entry) => {
      const r = asRecord(entry.item);
      return {
        ticketId: safeString(r.id),
        title: safeString(r.title ?? r.subject),
        ageHours: entry.age,
        deviceId: safeString(r.device_id),
        createdAtUtc: safeString(r.created_at)
      };
    })
    .sort((a, b) => b.ageHours - a.ageHours)
    .slice(0, 20);
  const unknownOpenTicketAgeCount = ticketsWithAge.filter((entry) => entry.age === undefined).length;

  const includeIncidentAndSpaceSummary = snapshot.providerScope !== 'partner';
  const partnerSummaryLines = buildPartnerSummaryLines(snapshot);
  const summary = [
    `Devices: ${snapshot.devices.length} total, ${offlineDevices.length} offline (${pct(offlineDevices.length, snapshot.devices.length)}%).`,
    ...(includeIncidentAndSpaceSummary
      ? [
          `Incidents: ${snapshot.incidents.length} total, ${activeIncidents.length} active (${pct(activeIncidents.length, snapshot.incidents.length)}%).`
        ]
      : []),
    `Tickets: ${snapshot.tickets.length} total, ${openTickets.length} open.`,
    ...(includeIncidentAndSpaceSummary
      ? [
          `${windowHours}h churn: ${recentIncidents.length} incidents across ${Object.keys(recentDevice).length} devices and ${Object.keys(recentSpace).length} spaces.`
        ]
      : []),
    ...(unknownIncidentAgeCount > 0 || unknownOpenTicketAgeCount > 0
      ? [
          `Timestamp quality: ${unknownIncidentAgeCount} incidents and ${unknownOpenTicketAgeCount} open tickets are missing valid created_at timestamps.`
        ]
      : []),
    ...partnerSummaryLines,
    `Data quality: ${mismatches.length} status mismatches detected.`
  ];

  return {
    schemaVersion: INSPECT_DEEP_DIVE_SCHEMA_VERSION,
    generatedAtUtc: snapshot.generatedAtUtc,
    tenantId: snapshot.tenantId,
    tenantName: snapshot.tenantName,
    windowHours,
    overviewMetrics: {
      totalDevices: snapshot.devices.length,
      offlineDevices: offlineDevices.length,
      offlinePct: pct(offlineDevices.length, snapshot.devices.length),
      totalIncidents: snapshot.incidents.length,
      activeIncidents: activeIncidents.length,
      activeIncidentPct: pct(activeIncidents.length, snapshot.incidents.length),
      totalTickets: snapshot.tickets.length,
      openTickets: openTickets.length,
      statusMismatches: mismatches.length
    },
    summary,
    topOfflineSpaces,
    topIncidentDevices,
    activeIncidentAging,
    churnWindow: {
      incidents: recentIncidents.length,
      devices: Object.keys(recentDevice).length,
      spaces: Object.keys(recentSpace).length,
      bySpace: topEntries(recentSpace, 10).map(([space, incidents]) => ({ space, incidents })),
      byDevice: topEntries(recentDevice, 10).map(([device, incidents]) => ({ device, incidents }))
    },
    ticketPosture: {
      openTickets: openTickets.length,
      overlappingActiveIncidentDevices: overlapDevices.size,
      oldestOpenTickets
    },
    dataQuality: {
      statusMismatches: mismatches
    }
  };
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}

function formatDeviceMatchReportMarkdown(result: z.infer<typeof DeviceMatchResultSchema>, tenantId: string): string {
  const sampleRows = result.matches.slice(0, 12);
  const lines = [
    '# Device Migration Matching Report',
    '',
    `Generated: ${result.generatedAtUtc}`,
    `Tenant: ${tenantId}`,
    '',
    '## Inputs',
    `- Source file: ${result.sourcePath}`,
    `- Target file: ${result.targetPath}`,
    `- Source field: ${result.sourceField}`,
    `- Target field: ${result.targetField}`,
    `- Output CSV: ${result.outputPath}`,
    '',
    '## Totals',
    `- Rows: ${result.totals.rows}`,
    `- Exact matches: ${result.totals.exact}`,
    `- Fuzzy matches: ${result.totals.fuzzy}`,
    `- Unmatched: ${result.totals.unmatched}`
  ];

  if (sampleRows.length > 0) {
    lines.push('', '## Sample Matches', '', '| Device | Target Space | Confidence | Status |', '| --- | --- | ---: | --- |');
    sampleRows.forEach((row) => {
      lines.push(
        `| ${row.deviceName} (${row.deviceId}) | ${row.targetSpaceName ?? 'Unmatched'} | ${row.confidence.toFixed(3)} | ${row.status} |`
      );
    });
  }

  return `${lines.join('\n')}\n`;
}

function formatDeviceMoveBatchReportMarkdown(result: z.infer<typeof DeviceMoveBatchReportSchema>): string {
  const succeededLabel = result.mode === 'dry-run' ? 'Ready to apply' : 'Succeeded';
  const lines = [
    '# Device Migration Execution Report',
    '',
    `Generated: ${result.generatedAtUtc}`,
    `Tenant: ${result.tenantId}`,
    '',
    '## Execution',
    `- Mode: ${result.mode}`,
    `- Rows: ${result.totals.rows}`,
    `- ${succeededLabel}: ${result.totals.succeeded}`,
    `- Failed: ${result.totals.failed}`,
    `- Skipped: ${result.totals.skipped}`,
    `- Stopped early: ${result.stoppedEarly ? 'yes' : 'no'}`
  ];

  if (result.reportPath) {
    lines.push(`- NDJSON report: ${result.reportPath}`);
  }
  if (result.firstError) {
    lines.push('', '## First Error', `- Row ${result.firstError.rowIndex}: ${result.firstError.message}`);
  }

  return `${lines.join('\n')}\n`;
}

function parseFleetInspectResult(value: unknown): FleetInspectResult['totals'] {
  const record = asRecord(value);
  const totals = asRecord(record.totals);
  return {
    devices: Number(totals.devices ?? 0),
    spaces: Number(totals.spaces ?? 0),
    incidents: Number(totals.incidents ?? 0),
    tickets: Number(totals.tickets ?? 0)
  };
}

export async function generateDeviceMigrationReport(args: {
  execution: z.infer<typeof DeviceMoveBatchReportSchema>;
  fleet: unknown;
  verification: unknown;
  tenantId: string;
  outPath: string;
}): Promise<FleetReportResult> {
  const fleetTotals = parseFleetInspectResult(args.fleet);
  const verification = parseMoveVerificationResult(args.verification);
  const issueRows = verification.rows.filter((row) => row.status !== 'verified');
  ensureDir(args.outPath);

  const lines = [
    '# Device Migration Post-Execution Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Tenant: ${args.tenantId}`,
    '',
    '## Execution',
    `- Mode: ${args.execution.mode}`,
    `- Rows: ${args.execution.totals.rows}`,
    `- Succeeded: ${args.execution.totals.succeeded}`,
    `- Failed: ${args.execution.totals.failed}`,
    `- Skipped: ${args.execution.totals.skipped}`,
    `- Stopped early: ${args.execution.stoppedEarly ? 'yes' : 'no'}`,
    '',
    '## Verification',
    `- Planned rows: ${verification.totals.rows}`,
    `- Verified: ${verification.totals.verified}`,
    `- Mismatched: ${verification.totals.mismatched}`,
    `- Missing: ${verification.totals.missing}`,
    '',
    '## Fleet Snapshot',
    `- Fleet devices: ${fleetTotals.devices}`,
    `- Fleet spaces: ${fleetTotals.spaces}`,
    `- Fleet incidents: ${fleetTotals.incidents}`,
    `- Fleet tickets: ${fleetTotals.tickets}`
  ];

  if (args.execution.reportPath) {
    lines.push(`- NDJSON report: ${args.execution.reportPath}`);
  }
  if (args.execution.firstError) {
    lines.push('', '## First Error', `- Row ${args.execution.firstError.rowIndex}: ${args.execution.firstError.message}`);
  }
  if (issueRows.length > 0) {
    lines.push('', '## Verification Issues', '', '| Row | Device | Target Space | Actual Space | Status | Detail |');
    lines.push('| ---: | --- | ---: | ---: | --- | --- |');
    issueRows.forEach((row) => {
      lines.push(
        `| ${row.rowIndex} | ${row.deviceName ?? row.deviceId} (${row.deviceId}) | ${row.targetSpaceId} | ${row.actualSpaceId ?? 'n/a'} | ${row.status} | ${row.detail} |`
      );
    });
  }

  writeFileSync(args.outPath, `${lines.join('\n')}\n`, 'utf8');
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    tenantId: args.tenantId,
    format: 'markdown',
    outputPath: resolve(args.outPath),
    includeSensitive: false
  };
}

export function parseDeepDiveForReport(raw: unknown, expectedTenantId?: string): DeepDiveResult {
  const parsed = DeepDiveResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Input JSON must be produced by `xyte-cli ops inspect deep-dive --output json`.');
  }

  if (expectedTenantId && parsed.data.tenantId !== expectedTenantId) {
    throw new Error(`Input tenant mismatch. Expected ${expectedTenantId}, got ${parsed.data.tenantId}.`);
  }

  return parsed.data;
}

export function parseReportInput(raw: unknown, expectedTenantId?: string): OpsReportInput {
  const deepDive = DeepDiveResultSchema.safeParse(raw);
  if (deepDive.success) {
    if (expectedTenantId && deepDive.data.tenantId !== expectedTenantId) {
      throw new Error(`Input tenant mismatch. Expected ${expectedTenantId}, got ${deepDive.data.tenantId}.`);
    }
    return deepDive.data;
  }

  const deviceMatch = DeviceMatchResultSchema.safeParse(raw);
  if (deviceMatch.success) {
    if (expectedTenantId && deviceMatch.data.tenantId && deviceMatch.data.tenantId !== expectedTenantId) {
      throw new Error(`Input tenant mismatch. Expected ${expectedTenantId}, got ${deviceMatch.data.tenantId}.`);
    }
    return deviceMatch.data;
  }

  const deviceMoveBatch = DeviceMoveBatchReportSchema.safeParse(raw);
  if (deviceMoveBatch.success) {
    if (expectedTenantId && deviceMoveBatch.data.tenantId !== expectedTenantId) {
      throw new Error(`Input tenant mismatch. Expected ${expectedTenantId}, got ${deviceMoveBatch.data.tenantId}.`);
    }
    return deviceMoveBatch.data;
  }

  throw new Error(
    'Input JSON must be produced by `xyte-cli ops inspect deep-dive --output json`, `xyte-cli util match`, or `xyte-cli util move-devices`.'
  );
}

export async function generateFleetReport(args: {
  deepDive: DeepDiveResult;
  format: 'markdown' | 'pdf';
  outPath: string;
  includeSensitive: boolean;
}): Promise<FleetReportResult> {
  const markdown = formatDeepDiveMarkdown(args.deepDive, args.includeSensitive);
  ensureDir(args.outPath);

  if (args.format === 'markdown') {
    writeFileSync(args.outPath, markdown, 'utf8');
  } else {
    const { renderBrandedPdfReport } = await import('./report/pdf-render');
    await renderBrandedPdfReport(args.deepDive, args.outPath, args.includeSensitive);
  }

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    tenantId: args.deepDive.tenantId,
    format: args.format,
    outputPath: resolve(args.outPath),
    includeSensitive: args.includeSensitive
  };
}

export async function generateOpsReport(args: {
  input: OpsReportInput;
  tenantId: string;
  format: 'markdown' | 'pdf';
  outPath: string;
  includeSensitive: boolean;
}): Promise<FleetReportResult> {
  if (args.input.schemaVersion === INSPECT_DEEP_DIVE_SCHEMA_VERSION) {
    return generateFleetReport({
      deepDive: args.input,
      format: args.format,
      outPath: args.outPath,
      includeSensitive: args.includeSensitive
    });
  }

  if (args.format === 'pdf') {
    throw new Error('PDF rendering is only supported for deep-dive report input.');
  }

  ensureDir(args.outPath);
  const markdown =
    args.input.schemaVersion === DEVICE_MATCH_SCHEMA_VERSION
      ? formatDeviceMatchReportMarkdown(args.input, args.input.tenantId ?? args.tenantId)
      : formatDeviceMoveBatchReportMarkdown(args.input);
  writeFileSync(args.outPath, markdown, 'utf8');

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    tenantId: args.input.tenantId ?? args.tenantId,
    format: args.format,
    outputPath: resolve(args.outPath),
    includeSensitive: args.includeSensitive
  };
}
