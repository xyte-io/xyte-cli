import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import type { XyteClient } from '../types/client';
import { asRecord, extractArray, extractHasNextPage } from '../utils/json';
import { INSPECT_DEEP_DIVE_SCHEMA_VERSION, INSPECT_FLEET_SCHEMA_VERSION, REPORT_SCHEMA_VERSION } from '../contracts/versions';
import { withSpan } from '../observability/tracing';
// Dynamic import: pdfkit is ~5.9MB and only needed for PDF generation.
// import { renderBrandedPdfReport } from './report/pdf-render';
import { parseTimestamp } from './report/time-format';

interface StatusCounts {
  [key: string]: number;
}

export type { InspectProviderScope } from '../types/settings-enums';
import type { InspectProviderScope } from '../types/settings-enums';
type ResolvedInspectProviderScope = Exclude<InspectProviderScope, 'auto'>;

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

interface PartnerEndpointOutcome {
  attempted: number;
  succeeded: number;
  failed: number;
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
    freshWithin24Hours: number;
  };
  stateHistoryCoverage: {
    withHistory: number;
    totalEntries: number;
  };
}

interface FleetInspectResult {
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
  churn24h: z.object({
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

interface FleetReportResult {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  generatedAtUtc: string;
  tenantId: string;
  format: 'markdown' | 'pdf';
  outputPath: string;
  includeSensitive: boolean;
}

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

function safeString(value: unknown): string {
  if (value === undefined || value === null) {
    return 'n/a';
  }
  return String(value);
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

function redactSensitive(value: string, includeSensitive: boolean): string {
  if (includeSensitive || value === 'n/a') {
    return value;
  }
  if (value.length <= 8) {
    return '***';
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

const PARTNER_ENRICHMENT_SAMPLE_SIZE = 25;
const PARTNER_ENRICHMENT_CONCURRENCY = 5;
const PARTNER_ENRICHMENT_TIMEOUT_MS = 3_000;
const PARTNER_FRESH_TELEMETRY_WINDOW_HOURS = 24;

function firstText(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function countValue(counter: StatusCounts, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function endpointOutcome(): PartnerEndpointOutcome {
  return {
    attempted: 0,
    succeeded: 0,
    failed: 0
  };
}

function totalCount(counter: StatusCounts): number {
  return Object.values(counter).reduce((sum, value) => sum + value, 0);
}

function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  return Promise.race([operation(), timeout]).finally(() => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractObject(value: unknown, preferredKeys: string[]): Record<string, unknown> {
  const record = asObject(value);
  if (!record) {
    return {};
  }
  for (const key of preferredKeys) {
    const candidate = asObject(record[key]);
    if (candidate) {
      return candidate;
    }
  }
  return record;
}

function deviceId(value: any): string | undefined {
  const raw = value?.id ?? value?.device_id ?? value?.device?.id;
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return undefined;
  }
  return String(raw);
}

function recencyBucket(timestamp: unknown): string {
  const parsed = parseTimestamp(timestamp);
  if (!parsed) {
    return 'unknown';
  }
  const ageMs = Math.max(0, Date.now() - parsed.getTime());
  if (ageMs <= 3_600_000) {
    return '<=1h';
  }
  if (ageMs <= 86_400_000) {
    return '1h-24h';
  }
  if (ageMs <= 604_800_000) {
    return '1d-7d';
  }
  return '>7d';
}

function latestTimestamp(items: any[]): Date | undefined {
  let latest: Date | undefined;
  for (const item of items) {
    const parsed = parseTimestamp(item?.timestamp ?? item?.created_at ?? item?.updated_at ?? item?.time ?? item?.recorded_at);
    if (!parsed) {
      continue;
    }
    if (!latest || parsed.getTime() > latest.getTime()) {
      latest = parsed;
    }
  }
  return latest;
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

async function mapWithConcurrency<T>(items: T[], concurrency: number, operation: (item: T) => Promise<void>): Promise<void> {
  let index = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const current = index;
        index += 1;
        if (current >= items.length) {
          return;
        }
        await operation(items[current]);
      }
    })
  );
}

async function paginateAll(args: {
  fetch: (query: { page: number; per_page: number }) => Promise<unknown>;
  fetchSingle: () => Promise<unknown>;
  extractionKeys: string[];
}): Promise<any[]> {
  const perPage = 100;
  const all: any[] = [];

  for (let page = 1; page <= 50; page += 1) {
    const raw = await args.fetch({ page, per_page: perPage });
    const pageItems = extractArray(raw, args.extractionKeys);
    if (!pageItems.length) {
      break;
    }
    all.push(...pageItems);
    if (pageItems.length < perPage) {
      break;
    }
  }

  if (all.length > 0) {
    return all;
  }

  const single = await args.fetchSingle();
  return extractArray(single, args.extractionKeys);
}

async function loadAllOrganizationDevices(client: XyteClient, tenantId: string): Promise<any[]> {
  return paginateAll({
    fetch: (query) => client.organization.getDevices({ tenantId, query }),
    fetchSingle: () => client.organization.getDevices({ tenantId }),
    extractionKeys: ['devices', 'data', 'items']
  });
}

async function loadAllPartnerDevices(client: XyteClient, tenantId: string): Promise<any[]> {
  return paginateAll({
    fetch: (query) => client.partner.getDevices({ tenantId, query }),
    fetchSingle: () => client.partner.getDevices({ tenantId }),
    extractionKeys: ['devices', 'data', 'items']
  });
}

async function loadAllSpaces(client: XyteClient, tenantId: string): Promise<any[]> {
  return paginateAll({
    fetch: (query) => client.organization.getSpaces({ tenantId, query }),
    fetchSingle: () => client.organization.getSpaces({ tenantId }),
    extractionKeys: ['spaces', 'data', 'items']
  });
}


async function loadAllOrganizationIncidents(client: XyteClient, tenantId: string): Promise<any[]> {
  const perPage = 100;
  const to = Math.floor(Date.now() / 1000);
  const merged = new Map<string, any>();
  const statuses = ['active', 'closed'] as const;

  for (const status of statuses) {
    for (let page = 1; page <= 50; page += 1) {
      const raw = await client.organization.getIncidents({
        tenantId,
        query: {
          status,
          from: 0,
          to,
          page,
          per_page: perPage
        }
      });

      const pageItems = extractArray(raw, ['incidents', 'data', 'items']);
      if (!pageItems.length) {
        break;
      }

      for (const incident of pageItems) {
        const rec = asRecord(incident);
        const id = safeString(typeof rec.id === 'string' ? rec.id : '');
        if (id) {
          merged.set(id, incident);
        } else {
          merged.set(`${status}:${merged.size}`, incident);
        }
      }

      const hasNext = extractHasNextPage(raw);
      if (hasNext === false || (hasNext === undefined && pageItems.length < perPage)) {
        break;
      }
    }
  }

  if (merged.size > 0) {
    return [...merged.values()];
  }

  const single = await client.organization.getIncidents({ tenantId });
  return extractArray(single, ['incidents', 'data', 'items']);
}

async function loadOrganizationTickets(client: XyteClient, tenantId: string): Promise<any[]> {
  const raw = await client.organization.getTickets({ tenantId });
  return extractArray(raw, ['tickets', 'data', 'items']);
}

async function loadPartnerTickets(client: XyteClient, tenantId: string): Promise<any[]> {
  const raw = await client.partner.getTickets({ tenantId });
  return extractArray(raw, ['tickets', 'data', 'items']);
}

async function collectPartnerEnrichment(
  client: XyteClient,
  tenantId: string,
  devices: any[]
): Promise<PartnerEnrichmentSnapshot> {
  const sampledDeviceIds = Array.from(new Set(devices.map((device) => deviceId(device)).filter((id): id is string => Boolean(id))))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, PARTNER_ENRICHMENT_SAMPLE_SIZE);

  const snapshot: PartnerEnrichmentSnapshot = {
    sampledDeviceCount: sampledDeviceIds.length,
    totalDeviceCount: devices.length,
    endpointAvailability: {
      deviceInfo: endpointOutcome(),
      commands: endpointOutcome(),
      telemetries: endpointOutcome(),
      stateHistory: endpointOutcome()
    },
    modelDistribution: {},
    firmwareDistribution: {},
    lastSeenRecency: {},
    commandPosture: {},
    telemetryCoverage: {
      withTelemetries: 0,
      freshWithin24Hours: 0
    },
    stateHistoryCoverage: {
      withHistory: 0,
      totalEntries: 0
    }
  };

  if (!sampledDeviceIds.length) {
    return snapshot;
  }

  const baseDevicesById = new Map<string, any>();
  for (const item of devices) {
    const id = deviceId(item);
    if (id && !baseDevicesById.has(id)) {
      baseDevicesById.set(id, item);
    }
  }

  async function safeCall(outcome: PartnerEndpointOutcome, operation: () => Promise<unknown>): Promise<unknown | undefined> {
    outcome.attempted += 1;
    try {
      const value = await withTimeout(operation, PARTNER_ENRICHMENT_TIMEOUT_MS);
      outcome.succeeded += 1;
      return value;
    } catch {
      outcome.failed += 1;
      return undefined;
    }
  }

  await mapWithConcurrency(sampledDeviceIds, PARTNER_ENRICHMENT_CONCURRENCY, async (id) => {
    const base = baseDevicesById.get(id);

    const infoRaw = await safeCall(snapshot.endpointAvailability.deviceInfo, () =>
      client.partner.getDeviceInfo({
        tenantId,
        path: { device_id: id }
      })
    );
    const info = extractObject(infoRaw, ['device', 'data', 'item']);

    const model = firstText(
      info.model_name,
      info.model,
      info.device_model,
      info.product_model,
      base?.model_name,
      base?.model,
      base?.device_model,
      base?.product_model
    );
    countValue(snapshot.modelDistribution, model ?? 'unknown');

    const firmware = firstText(
      info.firmware_version,
      info.firmware,
      info.software_version,
      info.version,
      base?.firmware_version,
      base?.firmware,
      base?.software_version,
      base?.version
    );
    countValue(snapshot.firmwareDistribution, firmware ?? 'unknown');

    const lastSeen = firstText(
      info.last_seen_at,
      info.last_seen,
      info.updated_at,
      base?.last_seen_at,
      base?.last_seen,
      base?.state?.last_seen_at
    );
    countValue(snapshot.lastSeenRecency, recencyBucket(lastSeen));

    const commandsRaw = await safeCall(snapshot.endpointAvailability.commands, () =>
      client.partner.getCommands({
        tenantId,
        path: { device_id: id }
      })
    );
    const commands = extractArray(commandsRaw, ['commands', 'data', 'items']);
    for (const command of commands) {
      const cmd = asRecord(command);
      const status = firstText(cmd.status, cmd.state, cmd.result);
      countValue(snapshot.commandPosture, status ? status.toLowerCase() : 'unknown');
    }

    const telemetriesRaw = await safeCall(snapshot.endpointAvailability.telemetries, () =>
      client.partner.getTelemetries({
        tenantId,
        path: { device_id: id }
      })
    );
    const telemetries = extractArray(telemetriesRaw, ['telemetries', 'data', 'items']);
    if (telemetries.length > 0) {
      snapshot.telemetryCoverage.withTelemetries += 1;
      const latest = latestTimestamp(telemetries);
      if (latest) {
        const age = Math.max(0, Date.now() - latest.getTime());
        if (age <= PARTNER_FRESH_TELEMETRY_WINDOW_HOURS * 3_600_000) {
          snapshot.telemetryCoverage.freshWithin24Hours += 1;
        }
      }
    }

    const historyRaw = await safeCall(snapshot.endpointAvailability.stateHistory, () =>
      client.partner.getStateHistory({
        tenantId,
        path: { device_id: id }
      })
    );
    const history = extractArray(historyRaw, ['history', 'state_history', 'states', 'data', 'items']);
    if (history.length > 0) {
      snapshot.stateHistoryCoverage.withHistory += 1;
      snapshot.stateHistoryCoverage.totalEntries += history.length;
    }
  });

  return snapshot;
}

function buildPartnerSummaryLines(snapshot: FleetSnapshot): string[] {
  if (snapshot.providerScope !== 'partner' || !snapshot.partnerEnrichment || snapshot.partnerEnrichment.sampledDeviceCount === 0) {
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
      `Partner telemetry coverage: ${enrichment.telemetryCoverage.withTelemetries}/${sampled} devices with telemetries, ${enrichment.telemetryCoverage.freshWithin24Hours}/${sampled} fresh <=24h.`
    );
  }

  if (enrichment.endpointAvailability.stateHistory.succeeded > 0) {
    lines.push(
      `Partner state history coverage: ${enrichment.stateHistoryCoverage.withHistory}/${sampled} devices with history, ${enrichment.stateHistoryCoverage.totalEntries} entries.`
    );
  }

  return lines;
}

async function resolveInspectProviderScope(
  client: XyteClient,
  tenantId: string,
  providerScope: InspectProviderScope
): Promise<ResolvedInspectProviderScope> {
  const endpoints = await client.listTenantEndpoints(tenantId);
  const hasOrganization = endpoints.some((endpoint) => endpoint.authScope === 'organization');
  const hasPartner = endpoints.some((endpoint) => endpoint.authScope === 'partner');

  if (providerScope === 'organization') {
    if (!hasOrganization) {
      throw new Error(
        `Inspect provider scope "organization" is unavailable for tenant ${tenantId}. Configure an xyte-org key or run with --provider-scope partner (inspect) or --inspect-provider-scope partner (flow run).`
      );
    }
    return 'organization';
  }

  if (providerScope === 'partner') {
    if (!hasPartner) {
      throw new Error(
        `Inspect provider scope "partner" is unavailable for tenant ${tenantId}. Configure an xyte-partner key or run with --provider-scope organization (inspect) or --inspect-provider-scope organization (flow run).`
      );
    }
    return 'partner';
  }

  if (hasOrganization && hasPartner) {
    throw new Error(
      `Inspect provider scope is ambiguous for tenant ${tenantId}: both organization and partner credentials are configured. Re-run with --provider-scope organization|partner (or --inspect-provider-scope for flow run).`
    );
  }

  if (hasPartner) {
    return 'partner';
  }

  // Preserve prior missing-key behavior when no provider is configured.
  return 'organization';
}

export async function collectFleetSnapshot(args: {
  client: XyteClient;
  tenantId: string;
  tenantName?: string;
  providerScope?: InspectProviderScope;
}): Promise<FleetSnapshot> {
  const { client, tenantId, tenantName, providerScope = 'auto' } = args;
  return withSpan('xyte.inspect.collect_snapshot', { 'xyte.tenant.id': tenantId }, async () => {
    const resolvedScope = await resolveInspectProviderScope(client, tenantId, providerScope);
    let devices: any[];
    let spaces: any[];
    let incidents: any[];
    let tickets: any[];
    let partnerEnrichment: PartnerEnrichmentSnapshot | undefined;

    if (resolvedScope === 'organization') {
      [devices, spaces, incidents, tickets] = await Promise.all([
        loadAllOrganizationDevices(client, tenantId),
        loadAllSpaces(client, tenantId),
        loadAllOrganizationIncidents(client, tenantId),
        loadOrganizationTickets(client, tenantId)
      ]);
    } else {
      [devices, tickets] = await Promise.all([
        loadAllPartnerDevices(client, tenantId),
        loadPartnerTickets(client, tenantId)
      ]);
      spaces = [];
      incidents = [];
      partnerEnrichment = await collectPartnerEnrichment(client, tenantId, devices);
    }

    const stableSort = (items: any[]) =>
      items.slice().sort((a, b) => safeString(a?.id ?? a?.name ?? a?.title).localeCompare(safeString(b?.id ?? b?.name ?? b?.title)));

    return {
      generatedAtUtc: new Date().toISOString(),
      tenantId,
      tenantName,
      providerScope: resolvedScope,
      devices: stableSort(devices),
      spaces: stableSort(spaces),
      incidents: stableSort(incidents),
      tickets: stableSort(tickets),
      partnerEnrichment
    };
  });
}

export function buildFleetInspect(snapshot: FleetSnapshot): FleetInspectResult {
  const deviceStatus = toCounter(snapshot.devices.map((item) => { const r = asRecord(item); return safeString(typeof r.status === 'string' ? r.status : 'unknown'); }));
  const incidentStatus = toCounter(snapshot.incidents.map((item) => { const r = asRecord(item); return safeString(typeof r.status === 'string' ? r.status : 'unknown'); }));
  const ticketStatus = toCounter(snapshot.tickets.map((item) => { const r = asRecord(item); return safeString(typeof r.status === 'string' ? r.status : 'unknown'); }));
  const spaceTypes = toCounter(snapshot.spaces.map((item) => { const r = asRecord(item); return safeString(typeof r.space_type === 'string' ? r.space_type : 'unknown'); }));

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

function asciiBar(label: string, count: number, total: number, width = 30): string {
  const share = total > 0 ? count / total : 0;
  const filled = Math.min(width, Math.max(0, Math.round(share * width)));
  const bar = `${'#'.repeat(filled)}${' '.repeat(width - filled)}`;
  return `${label.padEnd(12)} ${String(count).padStart(4)} |${bar}| ${String((share * 100).toFixed(1)).padStart(5)}%`;
}

export function formatFleetInspectAscii(result: FleetInspectResult): string {
  return [
    `Fleet Inspect Snapshot (${result.tenantId})`,
    `Generated: ${result.generatedAtUtc}`,
    '',
    'DEVICES',
    asciiBar('offline', result.status.devices.offline ?? 0, result.totals.devices),
    asciiBar('online', result.status.devices.online ?? 0, result.totals.devices),
    asciiBar('other', result.totals.devices - (result.status.devices.offline ?? 0) - (result.status.devices.online ?? 0), result.totals.devices),
    '',
    'INCIDENTS',
    asciiBar('active', result.status.incidents.active ?? 0, result.totals.incidents),
    asciiBar('closed', result.status.incidents.closed ?? 0, result.totals.incidents),
    '',
    'TICKETS',
    asciiBar('open', result.status.tickets.open ?? 0, Math.max(1, result.totals.tickets)),
    '',
    `Highlights: offline=${result.highlights.offlinePct}% active_incidents=${result.highlights.activeIncidentPct}% open_tickets=${result.highlights.openTickets}`
  ].join('\n');
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

  const activeDeviceIds = new Set(activeIncidents.map((item) => { const r = asRecord(item); return safeString(r.device_id ?? asRecord(r.device).id); }));
  const overlapDevices = new Set(openTickets.map((item) => safeString(asRecord(item).device_id)).filter((id) => activeDeviceIds.has(id)));

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
    .filter((item): item is { device: string; status: string; stateStatus: string; lastSeen: string; space: string } => Boolean(item))
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
      ? [`${windowHours}h churn: ${recentIncidents.length} incidents across ${Object.keys(recentDevice).length} devices and ${Object.keys(recentSpace).length} spaces.`]
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
    churn24h: {
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

export function formatDeepDiveAscii(result: DeepDiveResult): string {
  const hasOfflineSpaceData = result.topOfflineSpaces.length > 0;
  const hasIncidentData =
    result.topIncidentDevices.length > 0 ||
    result.activeIncidentAging.length > 0 ||
    result.churn24h.incidents > 0 ||
    result.churn24h.bySpace.length > 0 ||
    result.churn24h.byDevice.length > 0;
  const hasTicketData = result.ticketPosture.openTickets > 0 || result.ticketPosture.oldestOpenTickets.length > 0;

  const lines: string[] = [];
  lines.push(`Deep Dive (${result.tenantId})`);
  lines.push(`Generated: ${result.generatedAtUtc}`);
  lines.push('');
  lines.push('SUMMARY');
  result.summary.forEach((line) => lines.push(`- ${line}`));

  if (hasOfflineSpaceData) {
    lines.push('');
    lines.push('TOP OFFLINE SPACES');
    result.topOfflineSpaces.forEach((row) => lines.push(`${row.space} | offline=${row.offlineDevices} | share=${row.shareOfOfflinePct}%`));
  }

  if (hasIncidentData) {
    lines.push('');
    lines.push('TOP INCIDENT DEVICES');
    result.topIncidentDevices.forEach((row) =>
      lines.push(`${row.device} | incidents=${row.incidentCount} | active=${row.activeIncidents}`)
    );
    lines.push('');
    lines.push(`24H CHURN: incidents=${result.churn24h.incidents} devices=${result.churn24h.devices} spaces=${result.churn24h.spaces}`);
    result.churn24h.bySpace.forEach((row) => lines.push(`space: ${row.space} -> ${row.incidents}`));
  }

  if (hasTicketData) {
    lines.push('');
    lines.push(`OPEN TICKETS: ${result.ticketPosture.openTickets}`);
    if (hasIncidentData) {
      lines.push(`OVERLAP DEVICES: ${result.ticketPosture.overlappingActiveIncidentDevices}`);
    }
  }

  return lines.join('\n');
}

export function formatDeepDiveMarkdown(result: DeepDiveResult, includeSensitive = false): string {
  const hasOfflineSpaceData = result.topOfflineSpaces.length > 0;
  const hasIncidentData =
    result.topIncidentDevices.length > 0 ||
    result.activeIncidentAging.length > 0 ||
    result.churn24h.incidents > 0 ||
    result.churn24h.bySpace.length > 0 ||
    result.churn24h.byDevice.length > 0;
  const hasTicketData = result.ticketPosture.openTickets > 0 || result.ticketPosture.oldestOpenTickets.length > 0;
  const hasDataQualityIssues = result.dataQuality.statusMismatches.length > 0;
  const partnerHighlights = result.summary.filter((line) => line.startsWith('Partner '));

  const markdown: string[] = [];
  markdown.push('# Xyte Fleet Deep Dive');
  markdown.push('');
  markdown.push(`- Tenant: \`${result.tenantId}\``);
  markdown.push(`- Generated: \`${result.generatedAtUtc}\``);
  markdown.push(`- Window: \`${result.windowHours}h\``);
  markdown.push('');
  markdown.push('## Summary');
  markdown.push('');
  result.summary.forEach((line) => markdown.push(`- ${line}`));

  if (partnerHighlights.length > 0) {
    markdown.push('');
    markdown.push('## Partner Highlights');
    markdown.push('');
    partnerHighlights.forEach((line) => markdown.push(`- ${line}`));
  }

  if (hasOfflineSpaceData) {
    markdown.push('');
    markdown.push('## Top Offline Spaces');
    markdown.push('');
    markdown.push('| Space | Offline Devices | Share |');
    markdown.push('| --- | ---: | ---: |');
    result.topOfflineSpaces.forEach((row) => markdown.push(`| ${row.space} | ${row.offlineDevices} | ${row.shareOfOfflinePct}% |`));
  }

  if (hasIncidentData) {
    markdown.push('');
    markdown.push('## Top Devices by Incident Volume');
    markdown.push('');
    markdown.push('| Device | Incidents | Active |');
    markdown.push('| --- | ---: | ---: |');
    result.topIncidentDevices.forEach((row) => markdown.push(`| ${row.device} | ${row.incidentCount} | ${row.activeIncidents} |`));
    markdown.push('');
    markdown.push(`## ${result.windowHours}-Hour Churn`);
    markdown.push('');
    markdown.push(
      `Incidents: **${result.churn24h.incidents}**, devices: **${result.churn24h.devices}**, spaces: **${result.churn24h.spaces}**.`
    );
    if (result.churn24h.bySpace.length > 0) {
      markdown.push('');
      markdown.push('| Space | Incidents |');
      markdown.push('| --- | ---: |');
      result.churn24h.bySpace.forEach((row) => markdown.push(`| ${row.space} | ${row.incidents} |`));
    }
    if (result.churn24h.byDevice.length > 0) {
      markdown.push('');
      markdown.push('| Device | Incidents |');
      markdown.push('| --- | ---: |');
      result.churn24h.byDevice.forEach((row) => markdown.push(`| ${row.device} | ${row.incidents} |`));
    }
  }

  if (hasTicketData) {
    markdown.push('');
    markdown.push('## Ticket Posture');
    markdown.push('');
    markdown.push(`- Open tickets: **${result.ticketPosture.openTickets}**`);
    if (hasIncidentData) {
      markdown.push(`- Overlapping active-incident devices: **${result.ticketPosture.overlappingActiveIncidentDevices}**`);
    }
    if (result.ticketPosture.oldestOpenTickets.length > 0) {
      markdown.push('');
      markdown.push('| Ticket ID | Title | Age (h) | Device ID | Created At |');
      markdown.push('| --- | --- | ---: | --- | --- |');
      result.ticketPosture.oldestOpenTickets.slice(0, 10).forEach((row) => {
        markdown.push(
          `| ${redactSensitive(row.ticketId, includeSensitive)} | ${row.title} | ${row.ageHours} | ${redactSensitive(
            row.deviceId,
            includeSensitive
          )} | ${row.createdAtUtc} |`
        );
      });
    }
  }

  if (hasDataQualityIssues) {
    markdown.push('');
    markdown.push('## Data Quality');
    markdown.push('');
    markdown.push('| Device | Status | state.status | Last Seen | Space |');
    markdown.push('| --- | --- | --- | --- | --- |');
    result.dataQuality.statusMismatches.forEach((row) =>
      markdown.push(`| ${row.device} | ${row.status} | ${row.stateStatus} | ${row.lastSeen} | ${row.space} |`)
    );
  }

  return markdown.join('\n');
}

function ensureDir(filePath: string): void {
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}

function parseLegacyOverviewMetrics(summary: string[]): DeepDiveResult['overviewMetrics'] {
  const metrics = {
    totalDevices: 0,
    offlineDevices: 0,
    offlinePct: 0,
    totalIncidents: 0,
    activeIncidents: 0,
    activeIncidentPct: 0,
    totalTickets: 0,
    openTickets: 0,
    statusMismatches: 0
  };

  for (const line of summary) {
    const deviceMatch = line.match(/^Devices:\s+(\d+)\s+total,\s+(\d+)\s+offline\s+\(([\d.]+)%\)\.$/i);
    if (deviceMatch) {
      metrics.totalDevices = Number.parseInt(deviceMatch[1], 10);
      metrics.offlineDevices = Number.parseInt(deviceMatch[2], 10);
      metrics.offlinePct = Number.parseFloat(deviceMatch[3]);
      continue;
    }

    const incidentMatch = line.match(/^Incidents:\s+(\d+)\s+total,\s+(\d+)\s+active\s+\(([\d.]+)%\)\.$/i);
    if (incidentMatch) {
      metrics.totalIncidents = Number.parseInt(incidentMatch[1], 10);
      metrics.activeIncidents = Number.parseInt(incidentMatch[2], 10);
      metrics.activeIncidentPct = Number.parseFloat(incidentMatch[3]);
      continue;
    }

    const ticketMatch = line.match(/^Tickets:\s+(\d+)\s+total,\s+(\d+)\s+open\.$/i);
    if (ticketMatch) {
      metrics.totalTickets = Number.parseInt(ticketMatch[1], 10);
      metrics.openTickets = Number.parseInt(ticketMatch[2], 10);
      continue;
    }

    const mismatchMatch = line.match(/^Data quality:\s+(\d+)\s+status mismatches detected\.$/i);
    if (mismatchMatch) {
      metrics.statusMismatches = Number.parseInt(mismatchMatch[1], 10);
    }
  }

  return metrics;
}

export function parseDeepDiveForReport(raw: unknown, expectedTenantId?: string): DeepDiveResult {
  const parsed = DeepDiveResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('Input JSON must be produced by `xyte-cli ops inspect deep-dive --output json`.');
  }

  if (expectedTenantId && parsed.data.tenantId !== expectedTenantId) {
    throw new Error(`Input tenant mismatch. Expected ${expectedTenantId}, got ${parsed.data.tenantId}.`);
  }

  return parsed.data.overviewMetrics
    ? parsed.data
    : {
        ...parsed.data,
        overviewMetrics: parseLegacyOverviewMetrics(parsed.data.summary)
      };
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
