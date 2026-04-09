import { setTimeout as delay } from 'node:timers/promises';

import { classifyConnectivityError } from '../config/connectivity';
import type { ConnectivityResult, ConnectionState } from '../contracts/status';
import {
  computeRetryDelayMs,
  DEFAULT_RETRY_POLICY,
  isRetryableErrorClass,
  type RetryPolicyOptions,
  type RetryState
} from '../config/retry-policy';
import type { ProfileStore } from '../secure/profile-store';
import type { SecretStore } from '../secure/secret-store';
import type { XyteClient } from '../types/client';
import type { SecretProvider } from '../types/profile';
import type { EndpointNamespace } from '../types/endpoints';
import { SUPPORTED_SECRET_PROVIDERS } from '../types/profile';
import { extractArray, extractHasNextPage, extractIncidentsArray } from '../utils/json';
import { PROVIDER_ORG } from '../types/profile';

interface LoadOutcome<T> {
  data: T;
  connectionState: ConnectionState;
  error?: ConnectivityResult;
  retry: RetryState;
}

type QueryValue = string | number | boolean | null | undefined;
type QueryShape = Record<string, QueryValue>;

interface LoadWithOutcomeOptions {
  retry?: RetryPolicyOptions;
}

const STATE_SEVERITY: Record<ConnectionState, number> = {
  connected: 0,
  not_checked: 0,
  rate_limited: 1,
  network_error: 2,
  timeout: 3,
  auth_required: 4,
  missing_key: 5,
  unknown_error: 6
};

function stateSeverity(state: ConnectionState): number {
  return STATE_SEVERITY[state] ?? 7;
}

function pickWorstOutcome(outcomes: Array<LoadOutcome<unknown>>): LoadOutcome<unknown> {
  return outcomes.reduce((worst, current) =>
    stateSeverity(current.connectionState) >= stateSeverity(worst.connectionState) ? current : worst
  );
}

async function loadWithOutcome<T>(
  operation: () => Promise<T>,
  fallback: T,
  options: LoadWithOutcomeOptions = {}
): Promise<LoadOutcome<T>> {
  const retryOptions = { ...DEFAULT_RETRY_POLICY, ...(options.retry ?? {}) };
  let attempts = 0;
  let retried = false;

  for (let attempt = 1; attempt <= retryOptions.maxAttempts; attempt += 1) {
    attempts = attempt;
    try {
      const data = await operation();
      return {
        data,
        connectionState: 'connected',
        retry: { attempts, retried }
      };
    } catch (error) {
      const classified = classifyConnectivityError(error);
      const retryable = isRetryableErrorClass(classified.class) && classified.retriable;
      if (!retryable || attempt >= retryOptions.maxAttempts) {
        return {
          data: fallback,
          connectionState: classified.state,
          error: classified,
          retry: { attempts, retried }
        };
      }

      retried = true;
      const waitMs = computeRetryDelayMs(attempt, retryOptions);
      await delay(waitMs);
    }
  }

  return {
    data: fallback,
    connectionState: 'unknown_error',
    error: {
      state: 'unknown_error',
      class: 'unknown',
      message: 'Unknown loader failure.',
      retriable: true
    },
    retry: { attempts, retried }
  };
}

function mergeRetry(outcomes: Array<LoadOutcome<unknown>>): RetryState {
  return outcomes.reduce<RetryState>(
    (acc, outcome) => ({
      attempts: Math.max(acc.attempts, outcome.retry.attempts),
      retried: acc.retried || outcome.retry.retried
    }),
    { attempts: 0, retried: false }
  );
}

function compactQuery(query: QueryShape | undefined): Record<string, string | number | boolean> | undefined {
  if (!query) {
    return undefined;
  }

  const entries = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [key, typeof value === 'string' ? value.trim() : value] as const)
    .filter(([, value]) => value !== '');

  if (!entries.length) {
    return undefined;
  }

  return Object.fromEntries(entries) as Record<string, string | number | boolean>;
}

interface DashboardLoadResult {
  devices: unknown[];
  incidents: unknown[];
  tickets: unknown[];
}

interface DashboardLoadOptions {
  profileStore: ProfileStore;
}

export async function loadDashboardData(
  client: XyteClient,
  tenantId: string | undefined,
  options: DashboardLoadOptions
): Promise<LoadOutcome<DashboardLoadResult>> {
  const [devicesOutcome, incidentsOutcome, ticketsOutcome] = await Promise.all([
    loadDevicesData(client, tenantId, { profileStore: options.profileStore }),
    loadIncidentsData(client, tenantId),
    loadTicketsData(client, tenantId)
  ]);

  const worst = pickWorstOutcome([devicesOutcome, incidentsOutcome, ticketsOutcome]);
  return {
    data: {
      devices: devicesOutcome.data,
      incidents: incidentsOutcome.data,
      tickets: ticketsOutcome.data.tickets
    },
    connectionState: worst.connectionState,
    error: worst.error,
    retry: mergeRetry([devicesOutcome, incidentsOutcome, ticketsOutcome])
  };
}

interface DevicesQuery {
  space_id?: string;
}

interface DevicesLoadOptions {
  profileStore: ProfileStore;
  query?: DevicesQuery;
}

async function resolveTenantProvider(
  profileStore: ProfileStore,
  tenantId: string | undefined
): Promise<SecretProvider> {
  if (!tenantId) {
    throw new Error('Device loading requires a tenant id.');
  }

  const tenant = await profileStore.getTenant(tenantId);
  if (!tenant) {
    throw new Error(`Unknown tenant: ${tenantId}`);
  }
  if (!tenant.apiProvider) {
    throw new Error(
      `Tenant ${tenantId} has no API provider configured. Set an active provider-specific key before loading devices.`
    );
  }

  return tenant.apiProvider;
}

export async function loadDevicesData(
  client: XyteClient,
  tenantId: string | undefined,
  options: DevicesLoadOptions
): Promise<LoadOutcome<unknown[]>> {
  const result = await loadWithOutcome(async () => {
    const query = compactQuery(options.query as QueryShape | undefined);
    const provider = await resolveTenantProvider(options.profileStore, tenantId);
    const raw =
      provider === PROVIDER_ORG
        ? await client.organization.getDevices({ tenantId, ...(query ? { query } : {}) })
        : await client.partner.getDevices({ tenantId });
    const devices = extractArray(raw, ['devices', 'data', 'items']);
    const spaceId = String(options.query?.space_id ?? '').trim();
    if (!spaceId) {
      return devices;
    }
    return devices.filter((device) => matchesSpace(device, spaceId));
  }, []);
  return result;
}

interface IncidentsQuery {
  from?: number;
  to?: number;
  status?: string;
  priority?: string;
  title?: string;
  issue?: string;
  space_id?: string;
  page?: number;
  per_page?: number;
}

interface IncidentsLoadOptions {
  query?: IncidentsQuery;
  paginateAll?: boolean;
}

function normalizeIncidentItem(incident: unknown): Record<string, unknown> {
  return incident && typeof incident === 'object' ? (incident as Record<string, unknown>) : { value: incident };
}

export async function loadIncidentsData(
  client: XyteClient,
  tenantId: string | undefined,
  options: IncidentsLoadOptions = {}
): Promise<LoadOutcome<unknown[]>> {
  return loadWithOutcome(async () => {
    const nowUnix = Math.floor(Date.now() / 1000);
    const merged: IncidentsQuery = {
      status: 'active',
      from: 0,
      to: nowUnix,
      page: 1,
      per_page: 100,
      ...(options.query ?? {})
    };

    const paginateAll = options.paginateAll !== false;
    const perPage = Math.max(1, Number(merged.per_page ?? 100));
    const initialPage = Math.max(1, Number(merged.page ?? 1));

    const buildQuery = (page: number) =>
      compactQuery({
        from: merged.from,
        to: merged.to,
        status: merged.status,
        priority: merged.priority,
        title: merged.title,
        issue: merged.issue,
        space_id: merged.space_id,
        page,
        per_page: perPage
      });

    if (!paginateAll) {
      const query = buildQuery(initialPage);
      const raw = await client.organization.getIncidents({
        tenantId,
        ...(query ? { query } : {})
      });
      return extractIncidentsArray(raw).map(normalizeIncidentItem);
    }

    const all: unknown[] = [];

    for (let page = initialPage; page <= 50; page += 1) {
      const query = buildQuery(page);
      const raw = await client.organization.getIncidents({
        tenantId,
        ...(query ? { query } : {})
      });
      const pageItems = extractIncidentsArray(raw);
      if (!pageItems.length) {
        break;
      }
      all.push(...pageItems);
      const hasNext = extractHasNextPage(raw);
      if (hasNext === false || (hasNext === undefined && pageItems.length < perPage)) {
        break;
      }
    }

    if (!all.length) {
      const raw = await client.organization.getIncidents({ tenantId });
      return extractIncidentsArray(raw).map(normalizeIncidentItem);
    }

    return all.map(normalizeIncidentItem);
  }, []);
}

interface TicketsLoadResult {
  mode: EndpointNamespace;
  tickets: unknown[];
}

export async function loadTicketsData(client: XyteClient, tenantId: string | undefined): Promise<LoadOutcome<TicketsLoadResult>> {
  const orgOutcome = await loadWithOutcome(async () => {
    const org = await client.organization.getTickets({ tenantId });
    return extractArray(org, ['tickets', 'data', 'items']);
  }, []);

  if (orgOutcome.data.length || orgOutcome.connectionState === 'connected') {
    return {
      data: {
        mode: 'organization',
        tickets: orgOutcome.data
      },
      connectionState: orgOutcome.connectionState,
      error: orgOutcome.error,
      retry: orgOutcome.retry
    };
  }

  const partnerOutcome = await loadWithOutcome(async () => {
    const partner = await client.partner.getTickets({ tenantId });
    return extractArray(partner, ['tickets', 'data', 'items']);
  }, []);

  const worst = pickWorstOutcome([orgOutcome, partnerOutcome]);
  return {
    data: {
      mode: 'partner',
      tickets: partnerOutcome.data
    },
    connectionState: worst.connectionState,
    error: worst.error,
    retry: mergeRetry([orgOutcome, partnerOutcome])
  };
}

interface SpacesQuery {
  id?: string;
  name?: string;
  parent_id?: string | number;
  space_type?: string;
  created_before?: string;
  created_after?: string;
  path_includes?: string;
}

interface SpacesLoadOptions {
  query?: SpacesQuery;
}

export async function loadSpacesData(
  client: XyteClient,
  tenantId: string | undefined,
  options: SpacesLoadOptions = {}
): Promise<LoadOutcome<unknown[]>> {
  return loadWithOutcome(async () => {
    const query = compactQuery(options.query as QueryShape | undefined);
    const raw = await client.organization.getSpaces({ tenantId, ...(query ? { query } : {}) });
    return extractArray(raw, ['spaces', 'data', 'items']);
  }, []);
}

export interface CommandTemplate {
  mode: 'command' | 'friendly_name';
  value: string;
  label: string;
}

function normalizeCommandTemplates(items: unknown[]): CommandTemplate[] {
  const dedupe = new Set<string>();
  const templates: CommandTemplate[] = [];

  for (const item of items) {
    const rec = item && typeof item === 'object' ? (item as Record<string, unknown>) : undefined;
    const command = String(rec?.command ?? '').trim();
    const friendlyName = String(rec?.friendly_name ?? '').trim();

    if (command) {
      const key = `command:${command}`;
      if (!dedupe.has(key)) {
        dedupe.add(key);
        templates.push({
          mode: 'command',
          value: command,
          label: `command: ${command}`
        });
      }
    }

    if (friendlyName) {
      const key = `friendly_name:${friendlyName}`;
      if (!dedupe.has(key)) {
        dedupe.add(key);
        templates.push({
          mode: 'friendly_name',
          value: friendlyName,
          label: `friendly_name: ${friendlyName}`
        });
      }
    }
  }

  return templates;
}

export async function loadCommandTemplates(
  client: XyteClient,
  tenantId: string | undefined,
  options: { deviceId: string }
): Promise<LoadOutcome<CommandTemplate[]>> {
  return loadWithOutcome(async () => {
    const raw = await client.organization.getCommands({
      tenantId,
      path: { device_id: options.deviceId }
    });
    const commands = extractArray(raw, ['commands', 'data', 'items']);
    return normalizeCommandTemplates(commands);
  }, []);
}

interface SpaceDrilldownResult {
  spaceDetail?: unknown;
  devicesInSpace: unknown[];
  paneStatus: string;
}

function matchesSpace(device: unknown, spaceId: string): boolean {
  const rec = device && typeof device === 'object' ? (device as Record<string, unknown>) : undefined;
  const direct = String(rec?.space_id ?? '') === spaceId;
  const spaceObj = rec?.space && typeof rec.space === 'object' ? (rec.space as Record<string, unknown>) : undefined;
  const nested = String(spaceObj?.id ?? '') === spaceId;
  const alternate = String(rec?.spaceId ?? '') === spaceId;
  return direct || nested || alternate;
}

export async function loadSpaceDrilldownData(
  client: XyteClient,
  tenantId: string | undefined,
  options: { spaceId: string; allDevicesCache?: unknown[]; profileStore: ProfileStore }
): Promise<LoadOutcome<SpaceDrilldownResult>> {
  const { spaceId, allDevicesCache = [] } = options;
  const [detailOutcome, queriedDevicesOutcome] = await Promise.all([
    loadWithOutcome(() => client.organization.getSpace({ tenantId, path: { space_id: spaceId } }), undefined),
    loadWithOutcome(async () => {
      const queried = await client.organization.getDevices({ tenantId, query: { space_id: spaceId } });
      return extractArray(queried, ['devices', 'data', 'items']);
    }, [])
  ]);

  let devicesInSpace = queriedDevicesOutcome.data;
  let paneStatus = 'Loaded space detail and device listing.';
  let fallbackOutcome: LoadOutcome<unknown[]> | undefined;

  if (!devicesInSpace.length) {
    if (allDevicesCache.length) {
      devicesInSpace = allDevicesCache.filter((device) => matchesSpace(device, spaceId));
      paneStatus = 'Filtered devices by cached space_id fallback.';
    } else {
      fallbackOutcome = await loadDevicesData(client, tenantId, {
        profileStore: options.profileStore
      });
      devicesInSpace = fallbackOutcome.data.filter((device) => matchesSpace(device, spaceId));
      paneStatus = 'Filtered devices by fetched space_id fallback.';
    }
  }

  const allOutcomes = [detailOutcome, queriedDevicesOutcome, ...(fallbackOutcome ? [fallbackOutcome] : [])];
  const worst = pickWorstOutcome(allOutcomes as Array<LoadOutcome<unknown>>);

  return {
    data: {
      spaceDetail: detailOutcome.data,
      devicesInSpace,
      paneStatus
    },
    connectionState: worst.connectionState,
    error: worst.error,
    retry: mergeRetry(allOutcomes as Array<LoadOutcome<unknown>>)
  };
}

export function getSpaceId(space: unknown): string {
  const rec = space && typeof space === 'object' ? (space as Record<string, unknown>) : undefined;
  return String(rec?.id ?? rec?._id ?? rec?.space_id ?? '');
}

export function getSpaceName(space: unknown): string {
  const rec = space && typeof space === 'object' ? (space as Record<string, unknown>) : undefined;
  return String(rec?.name ?? rec?.title ?? rec?.path ?? 'n/a');
}

const CONFIG_PROVIDERS: SecretProvider[] = [...SUPPORTED_SECRET_PROVIDERS];

interface ConfigProviderRow {
  provider: SecretProvider;
  slotCount: number;
  activeSlot: string;
  hasSecret: 'yes' | 'no';
  lastValidatedAt?: string;
}

interface ConfigSlotRow {
  provider: SecretProvider;
  slotId: string;
  name: string;
  active: 'yes' | 'no';
  hasSecret: 'yes' | 'no';
  fingerprint: string;
}

interface ConfigData {
  providerRows: ConfigProviderRow[];
  selectedProvider: SecretProvider;
  slotRows: ConfigSlotRow[];
}

/**
 * Infrastructure-tier loader: takes store primitives directly rather than a XyteClient.
 * Intentionally differs from fleet-tier loaders (loadDevicesData, loadSpaceDrilldownData, etc.)
 * which follow the (client, tenantId, options) convention.
 */
export async function readConfigData(
  profileStore: ProfileStore,
  secretStore: SecretStore,
  tenantId: string | undefined
): Promise<ConfigData> {
  const allSlots = tenantId ? await profileStore.listKeySlots(tenantId) : [];

  const providerRows: ConfigProviderRow[] = await Promise.all(
    CONFIG_PROVIDERS.map(async (provider) => {
      const providerSlots = allSlots.filter((slot) => slot.provider === provider);
      const activeSlot = tenantId ? await profileStore.getActiveKeySlot(tenantId, provider) : undefined;
      const hasActiveSecret =
        tenantId && activeSlot
          ? Boolean(await secretStore.getSlotSecret(tenantId, provider, activeSlot.slotId))
          : false;
      return {
        provider,
        slotCount: providerSlots.length,
        activeSlot: activeSlot?.slotId ?? 'none',
        hasSecret: hasActiveSecret ? 'yes' : 'no',
        lastValidatedAt: activeSlot?.lastValidatedAt
      };
    })
  );

  const selectedProvider = providerRows.find((row) => row.slotCount > 0)?.provider ?? PROVIDER_ORG;

  const slotRows: ConfigSlotRow[] = await Promise.all(
    allSlots
      .filter((slot) => slot.provider === selectedProvider)
      .map(async (slot) => {
        const active = tenantId ? await profileStore.getActiveKeySlot(tenantId, slot.provider) : undefined;
        const hasSecret = tenantId
          ? Boolean(await secretStore.getSlotSecret(tenantId, slot.provider, slot.slotId))
          : false;
        return {
          provider: slot.provider,
          slotId: slot.slotId,
          name: slot.name,
          active: active?.slotId === slot.slotId ? 'yes' : 'no',
          hasSecret: hasSecret ? 'yes' : 'no',
          fingerprint: slot.fingerprint
        };
      })
  );

  return { providerRows, selectedProvider, slotRows };
}
