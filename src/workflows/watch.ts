import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { toProblemDetails } from '../contracts/problem';
import { buildWatchFrame, type WatchDelta, type WatchFrameV1, type WatchProfile } from '../contracts/watch-frame';
import type { XyteClient } from '../types/client';

type QueryValue = string | number | boolean | null | undefined;

const WATCH_ENDPOINT_KEY = 'organization.incidents.getIncidents';
const WATCH_MIN_INTERVAL_MS = 1000;
const WATCH_DEFAULT_MAX_POLLS = 600;
const WATCH_MAX_POLLS = 3600;

interface NormalizedIncident {
  id: string;
  raw: unknown;
  stable: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function extractArray(value: unknown, preferredKeys: string[] = ['data', 'items']): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  const record = asRecord(value);
  for (const key of preferredKeys) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
    }
  }

  for (const key of Object.keys(record)) {
    if (Array.isArray(record[key])) {
      return record[key] as unknown[];
    }
  }

  return [];
}

function extractIncidentsArray(value: unknown): unknown[] {
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

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stableNormalize(item));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    normalized[key] = stableNormalize(record[key]);
  }
  return normalized;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(stableNormalize(value));
}

function resolveIncidentId(item: unknown, stable: string): string {
  const record = asRecord(item);
  const candidates = [record.id, record._id, record.incident_id]
    .map((value) => String(value ?? '').trim())
    .filter((value) => value.length > 0);

  if (candidates.length > 0) {
    return candidates[0];
  }

  const digest = createHash('sha1').update(stable).digest('hex').slice(0, 16);
  return `anon:${digest}`;
}

function normalizeIncidents(items: unknown[]): NormalizedIncident[] {
  const deduped = new Map<string, NormalizedIncident>();

  for (const item of items) {
    const stable = stableStringify(item);
    const id = resolveIncidentId(item, stable);
    deduped.set(id, {
      id,
      raw: item,
      stable
    });
  }

  return Array.from(deduped.values()).sort((left, right) => left.id.localeCompare(right.id));
}

function toMap(items: NormalizedIncident[]): Map<string, NormalizedIncident> {
  const map = new Map<string, NormalizedIncident>();
  for (const item of items) {
    map.set(item.id, item);
  }
  return map;
}

function computeDelta(previous: NormalizedIncident[], current: NormalizedIncident[]): WatchDelta {
  const previousById = toMap(previous);
  const currentById = toMap(current);

  const previousIds = Array.from(previousById.keys()).sort();
  const currentIds = Array.from(currentById.keys()).sort();

  const added = currentIds
    .filter((id) => !previousById.has(id))
    .map((id) => ({
      id,
      current: currentById.get(id)?.raw
    }));

  const removed = previousIds
    .filter((id) => !currentById.has(id))
    .map((id) => ({
      id,
      previous: previousById.get(id)?.raw
    }));

  const updated = currentIds
    .filter((id) => previousById.has(id))
    .filter((id) => {
      const previousItem = previousById.get(id);
      const currentItem = currentById.get(id);
      return previousItem?.stable !== currentItem?.stable;
    })
    .map((id) => ({
      id,
      before: previousById.get(id)?.raw,
      after: currentById.get(id)?.raw
    }));

  return {
    added,
    removed,
    updated
  };
}

function isDeltaChanged(delta: WatchDelta): boolean {
  return delta.added.length > 0 || delta.removed.length > 0 || delta.updated.length > 0;
}

function buildQuery(overrides: Record<string, QueryValue>, nowUnix: number): Record<string, QueryValue> {
  return {
    status: 'active',
    from: 0,
    to: nowUnix,
    page: 1,
    per_page: 100,
    ...overrides
  };
}

interface RunWatchOptions {
  client: XyteClient;
  tenantId?: string;
  profile?: WatchProfile;
  query?: Record<string, QueryValue>;
  intervalMs?: number;
  once?: boolean;
  maxPolls?: number;
  onFrame: (frame: WatchFrameV1) => void;
}

export async function runWatch(options: RunWatchOptions): Promise<void> {
  const profile = options.profile ?? 'incidents-active';
  const intervalMs = Math.max(WATCH_MIN_INTERVAL_MS, options.intervalMs ?? 2000);
  const requestedMaxPolls = options.once ? 1 : options.maxPolls ?? WATCH_DEFAULT_MAX_POLLS;
  const maxPolls = Math.max(1, Math.min(WATCH_MAX_POLLS, requestedMaxPolls));
  const queryOverrides = options.query ?? {};

  const runId = randomUUID();
  let sequence = 0;
  let pollIndex = 0;
  let baseline: NormalizedIncident[] | undefined;
  let running = true;

  const stop = () => {
    running = false;
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    while (running) {
      pollIndex += 1;
      const query = buildQuery(queryOverrides, Math.floor(Date.now() / 1000));

      try {
        const response = await options.client.callWithMeta(WATCH_ENDPOINT_KEY, {
          tenantId: options.tenantId,
          query
        });
        const incidents = normalizeIncidents(extractIncidentsArray(response.data));

        if (!baseline) {
          options.onFrame(
            buildWatchFrame({
              runId,
              sequence,
              pollIndex,
              intervalMs,
              profile,
              endpointKey: WATCH_ENDPOINT_KEY,
              tenantId: options.tenantId,
              eventType: 'snapshot',
              query,
              summary: {
                total: incidents.length,
                added: 0,
                removed: 0,
                updated: 0,
                changed: false
              },
              items: incidents.map((item) => item.raw)
            })
          );
        } else {
          const delta = computeDelta(baseline, incidents);
          const changed = isDeltaChanged(delta);

          options.onFrame(
            buildWatchFrame({
              runId,
              sequence,
              pollIndex,
              intervalMs,
              profile,
              endpointKey: WATCH_ENDPOINT_KEY,
              tenantId: options.tenantId,
              eventType: changed ? 'delta' : 'heartbeat',
              query,
              summary: {
                total: incidents.length,
                added: delta.added.length,
                removed: delta.removed.length,
                updated: delta.updated.length,
                changed
              },
              ...(changed ? { delta } : {})
            })
          );
        }

        baseline = incidents;
      } catch (error) {
        options.onFrame(
          buildWatchFrame({
            runId,
            sequence,
            pollIndex,
            intervalMs,
            profile,
            endpointKey: WATCH_ENDPOINT_KEY,
            tenantId: options.tenantId,
            eventType: 'error',
            query,
            summary: {
              total: baseline?.length ?? 0,
              added: 0,
              removed: 0,
              updated: 0,
              changed: false
            },
            error: toProblemDetails(error, `/watch/${WATCH_ENDPOINT_KEY}`)
          })
        );

        if (options.once) {
          throw error;
        }
      }

      sequence += 1;

      if ((maxPolls !== undefined && pollIndex >= maxPolls) || !running) {
        break;
      }

      await delay(intervalMs);
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
