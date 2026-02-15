import { setTimeout as delay } from 'node:timers/promises';

import { classifyConnectivityError, type ConnectivityResult, type ConnectionState } from '../config/connectivity';
import { computeRetryDelayMs, DEFAULT_RETRY_POLICY, isRetryableErrorClass, type RetryPolicyOptions, type RetryState } from '../config/retry-policy';
import type { XyteClient } from '../types/client';

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function extractArray(value: unknown, preferredKeys: string[] = ['data', 'items']): any[] {
  if (Array.isArray(value)) {
    return value;
  }

  const record = asRecord(value);
  for (const key of preferredKeys) {
    if (Array.isArray(record[key])) {
      return record[key] as any[];
    }
  }

  for (const key of Object.keys(record)) {
    if (Array.isArray(record[key])) {
      return record[key] as any[];
    }
  }

  return [];
}

function extractIncidentsArray(value: unknown): any[] {
  const primary = extractArray(value, ['incidents', 'data', 'items']);
  if (primary.length > 0) {
    return primary;
  }

  const record = asRecord(value);
  const wrappers = ['payload', 'result', 'response', 'body'];
  for (const wrapper of wrappers) {
    const nested = extractArray(record[wrapper], ['incidents', 'data', 'items']);
    if (nested.length > 0) {
      return nested;
    }
  }

  return primary;
}

export interface LoadOutcome<T> {
  data: T;
  connectionState: ConnectionState;
  error?: ConnectivityResult;
  retry: RetryState;
}

interface LoadWithOutcomeOptions {
  retry?: RetryPolicyOptions;
}

function stateSeverity(state: ConnectionState): number {
  if (state === 'connected') {
    return 0;
  }
  if (state === 'rate_limited') {
    return 1;
  }
  if (state === 'network_error') {
    return 2;
  }
  if (state === 'timeout') {
    return 3;
  }
  if (state === 'auth_required') {
    return 4;
  }
  if (state === 'missing_key') {
    return 5;
  }
  if (state === 'unknown_error') {
    return 6;
  }
  return 7;
}

function pickWorstOutcome(outcomes: Array<LoadOutcome<unknown>>): LoadOutcome<unknown> {
  return outcomes.reduce((worst, current) => {
    if (!worst) {
      return current;
    }
    return stateSeverity(current.connectionState) >= stateSeverity(worst.connectionState) ? current : worst;
  });
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

export interface DashboardLoadResult {
  devices: any[];
  incidents: any[];
  tickets: any[];
}

export async function loadDashboardData(client: XyteClient, tenantId?: string): Promise<LoadOutcome<DashboardLoadResult>> {
  const [devicesOutcome, incidentsOutcome, ticketsOutcome] = await Promise.all([
    loadDevicesData(client, tenantId),
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

export async function loadDevicesData(client: XyteClient, tenantId?: string): Promise<LoadOutcome<any[]>> {
  const result = await loadWithOutcome(
    async () => {
      const raw = await client.organization
        .getDevices({ tenantId })
        .catch(() => client.partner.getDevices({ tenantId }));
      return extractArray(raw, ['devices', 'data', 'items']);
    },
    []
  );
  return result;
}

export async function loadIncidentsData(client: XyteClient, tenantId?: string): Promise<LoadOutcome<any[]>> {
  return loadWithOutcome(
    async () => {
      const raw = await client.organization.getIncidents({ tenantId });
      return extractIncidentsArray(raw).map((incident) => (incident && typeof incident === 'object' ? incident : { value: incident }));
    },
    []
  );
}

export interface TicketsLoadResult {
  mode: 'organization' | 'partner';
  tickets: any[];
}

export async function loadTicketsData(client: XyteClient, tenantId?: string): Promise<LoadOutcome<TicketsLoadResult>> {
  const orgOutcome = await loadWithOutcome(
    async () => {
      const org = await client.organization.getTickets({ tenantId });
      return extractArray(org, ['tickets', 'data', 'items']);
    },
    []
  );

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

  const partnerOutcome = await loadWithOutcome(
    async () => {
      const partner = await client.partner.getTickets({ tenantId });
      return extractArray(partner, ['tickets', 'data', 'items']);
    },
    []
  );

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

export async function loadSpacesData(client: XyteClient, tenantId?: string): Promise<LoadOutcome<any[]>> {
  return loadWithOutcome(
    async () => {
      const raw = await client.organization.getSpaces({ tenantId });
      return extractArray(raw, ['spaces', 'data', 'items']);
    },
    []
  );
}

export interface SpaceDrilldownResult {
  spaceDetail?: unknown;
  devicesInSpace: any[];
  paneStatus: string;
}

function matchesSpace(device: any, spaceId: string): boolean {
  const direct = String(device?.space_id ?? '') === spaceId;
  const nested = String(device?.space?.id ?? '') === spaceId;
  const alternate = String(device?.spaceId ?? '') === spaceId;
  return direct || nested || alternate;
}

export async function loadSpaceDrilldownData(
  client: XyteClient,
  tenantId: string | undefined,
  spaceId: string,
  allDevicesCache: any[]
): Promise<LoadOutcome<SpaceDrilldownResult>> {
  const [detailOutcome, queriedDevicesOutcome] = await Promise.all([
    loadWithOutcome(() => client.organization.getSpace({ tenantId, path: { space_id: spaceId } }), undefined),
    loadWithOutcome(
      async () => {
        const queried = await client.organization.getDevices({ tenantId, query: { space_id: spaceId } });
        return extractArray(queried, ['devices', 'data', 'items']);
      },
      []
    )
  ]);

  let devicesInSpace = queriedDevicesOutcome.data;
  let paneStatus = 'Loaded space detail and device listing.';
  let fallbackOutcome: LoadOutcome<any[]> | undefined;

  if (!devicesInSpace.length) {
    if (allDevicesCache.length) {
      devicesInSpace = allDevicesCache.filter((device) => matchesSpace(device, spaceId));
      paneStatus = 'Filtered devices by cached space_id fallback.';
    } else {
      fallbackOutcome = await loadDevicesData(client, tenantId);
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

export function getSpaceId(space: any): string {
  return String(space?.id ?? space?._id ?? space?.space_id ?? '');
}

export function getSpaceName(space: any): string {
  return String(space?.name ?? space?.title ?? space?.path ?? 'n/a');
}
