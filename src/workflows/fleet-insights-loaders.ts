import type { XyteClient } from '../types/client';
import type { InspectProviderScope } from '../types/settings-enums';
import { asRecord, asRecordOrUndefined, extractArray, extractHasNextPage, firstText, safeString } from '../utils/json';
import { withSpan } from '../observability/tracing';
import { parseTimestamp } from './report/time-format';

import type {
  FleetSnapshot,
  PartnerEnrichmentSnapshot,
  PartnerEndpointOutcome,
  ResolvedInspectProviderScope,
  StatusCounts
} from '../types/fleet-inspect';

export class InspectProviderScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectProviderScopeError';
  }
}

const PARTNER_ENRICHMENT_SAMPLE_SIZE = 25;
const PARTNER_ENRICHMENT_CONCURRENCY = 5;
const PARTNER_ENRICHMENT_TIMEOUT_MS = 3_000;
const PARTNER_FRESH_TELEMETRY_WINDOW_HOURS = 24;

function countValue(counter: StatusCounts, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

function emptyEndpointOutcome(): PartnerEndpointOutcome {
  return {
    attempted: 0,
    succeeded: 0,
    failed: 0
  };
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

function extractObject(value: unknown, preferredKeys: string[]): Record<string, unknown> {
  const record = asRecordOrUndefined(value);
  if (!record) {
    return {};
  }
  for (const key of preferredKeys) {
    const candidate = asRecordOrUndefined(record[key]);
    if (candidate) {
      return candidate;
    }
  }
  return record;
}

function deviceId(value: unknown): string | undefined {
  const r = asRecord(value);
  const raw = r.id ?? r.device_id ?? asRecord(r.device).id;
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

function latestTimestamp(items: unknown[]): Date | undefined {
  let latest: Date | undefined;
  for (const item of items) {
    const r = asRecord(item);
    const parsed = parseTimestamp(r.timestamp ?? r.created_at ?? r.updated_at ?? r.time ?? r.recorded_at);
    if (!parsed) {
      continue;
    }
    if (!latest || parsed.getTime() > latest.getTime()) {
      latest = parsed;
    }
  }
  return latest;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<void>
): Promise<void> {
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
}): Promise<unknown[]> {
  const perPage = 100;
  const all: unknown[] = [];

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

function loadAllOrganizationDevices(client: XyteClient, tenantId: string): Promise<unknown[]> {
  return paginateAll({
    fetch: (query) => client.organization.getDevices({ tenantId, query }),
    fetchSingle: () => client.organization.getDevices({ tenantId }),
    extractionKeys: ['devices', 'data', 'items']
  });
}

function loadAllPartnerDevices(client: XyteClient, tenantId: string): Promise<unknown[]> {
  return paginateAll({
    fetch: (query) => client.partner.getDevices({ tenantId, query }),
    fetchSingle: () => client.partner.getDevices({ tenantId }),
    extractionKeys: ['devices', 'data', 'items']
  });
}

function loadAllSpaces(client: XyteClient, tenantId: string): Promise<unknown[]> {
  return paginateAll({
    fetch: (query) => client.organization.getSpaces({ tenantId, query }),
    fetchSingle: () => client.organization.getSpaces({ tenantId }),
    extractionKeys: ['spaces', 'data', 'items']
  });
}

async function loadAllOrganizationIncidents(client: XyteClient, tenantId: string): Promise<unknown[]> {
  const perPage = 100;
  const to = Math.floor(Date.now() / 1000);
  const merged = new Map<string, unknown>();
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

async function loadOrganizationTickets(client: XyteClient, tenantId: string): Promise<unknown[]> {
  const raw = await client.organization.getTickets({ tenantId });
  return extractArray(raw, ['tickets', 'data', 'items']);
}

async function loadPartnerTickets(client: XyteClient, tenantId: string): Promise<unknown[]> {
  const raw = await client.partner.getTickets({ tenantId });
  return extractArray(raw, ['tickets', 'data', 'items']);
}

async function collectPartnerEnrichment(
  client: XyteClient,
  tenantId: string,
  devices: unknown[]
): Promise<PartnerEnrichmentSnapshot> {
  const sampledDeviceIds = Array.from(
    new Set(devices.map((device) => deviceId(device)).filter((id): id is string => Boolean(id)))
  )
    .sort((a, b) => a.localeCompare(b))
    .slice(0, PARTNER_ENRICHMENT_SAMPLE_SIZE);

  const snapshot: PartnerEnrichmentSnapshot = {
    sampledDeviceCount: sampledDeviceIds.length,
    totalDeviceCount: devices.length,
    endpointAvailability: {
      deviceInfo: emptyEndpointOutcome(),
      commands: emptyEndpointOutcome(),
      telemetries: emptyEndpointOutcome(),
      stateHistory: emptyEndpointOutcome()
    },
    modelDistribution: {},
    firmwareDistribution: {},
    lastSeenRecency: {},
    commandPosture: {},
    telemetryCoverage: {
      withTelemetries: 0,
      freshWithinWindow: 0
    },
    stateHistoryCoverage: {
      withHistory: 0,
      totalEntries: 0
    }
  };

  if (!sampledDeviceIds.length) {
    return snapshot;
  }

  const baseDevicesById = new Map<string, Record<string, unknown>>();
  for (const item of devices) {
    const id = deviceId(item);
    if (id && !baseDevicesById.has(id)) {
      baseDevicesById.set(id, asRecord(item));
    }
  }

  async function safeCall(
    outcome: PartnerEndpointOutcome,
    operation: () => Promise<unknown>
  ): Promise<unknown | undefined> {
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
      asRecord(base?.state).last_seen_at
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
          snapshot.telemetryCoverage.freshWithinWindow += 1;
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
      throw new InspectProviderScopeError(
        `Inspect provider scope "organization" is unavailable for tenant ${tenantId}. Configure an xyte-org key or run with --provider-scope partner (inspect) or --inspect-provider-scope partner (flow run).`
      );
    }
    return 'organization';
  }

  if (providerScope === 'partner') {
    if (!hasPartner) {
      throw new InspectProviderScopeError(
        `Inspect provider scope "partner" is unavailable for tenant ${tenantId}. Configure an xyte-partner key or run with --provider-scope organization (inspect) or --inspect-provider-scope organization (flow run).`
      );
    }
    return 'partner';
  }

  if (hasOrganization && hasPartner) {
    throw new InspectProviderScopeError(
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
    let devices: unknown[];
    let spaces: unknown[];
    let incidents: unknown[];
    let tickets: unknown[];
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

    const stableSort = (items: unknown[]) =>
      items.slice().sort((a, b) => {
        const ra = asRecord(a);
        const rb = asRecord(b);
        return safeString(ra.id ?? ra.name ?? ra.title).localeCompare(safeString(rb.id ?? rb.name ?? rb.title));
      });

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
