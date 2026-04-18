import { describe, expect, it } from 'vitest';

import { XyteHttpError } from '../src/http/errors';
import {
  pollEdgeStatus,
  parsePositiveInt,
  type EdgeProbePollArgs,
  type EdgePollResult
} from '../src/workflows/edge-poll';
import type { XyteCallArgs, XyteCallResult, XyteClient } from '../src/types/client';

type ScriptedResponse =
  | { ok: true; data: unknown }
  | { ok: false; status: number; detail: string; headers?: Record<string, string> };

function buildClient(script: ScriptedResponse[]): XyteClient {
  let index = 0;
  const callWithMeta = async <T = unknown>(_endpointKey: string, _args?: XyteCallArgs): Promise<XyteCallResult<T>> => {
    const next = script[Math.min(index, script.length - 1)];
    index += 1;
    if (next.ok) {
      return {
        status: 200,
        headers: {},
        data: next.data as T,
        durationMs: 1,
        retryCount: 0,
        attempts: 1
      };
    }
    throw new XyteHttpError({
      message: next.detail,
      status: next.status,
      statusText: String(next.status),
      details: { detail: next.detail },
      headers: next.headers
    });
  };

  return {
    callWithMeta,
    call: async <T>(key: string, args?: XyteCallArgs) => (await callWithMeta<T>(key, args)).data,
    organization: {} as XyteClient['organization'],
    partner: {} as XyteClient['partner'],
    describeEndpoint: () => {
      throw new Error('describeEndpoint not used in tests');
    },
    listEndpoints: () => [],
    listTenantEndpoints: async () => []
  };
}

function controlledClock(): { now: () => number; advance: (ms: number) => void } {
  let current = Date.UTC(2026, 3, 18, 10, 0, 0);
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    }
  };
}

async function runPoll(args: Partial<EdgeProbePollArgs> & Pick<EdgeProbePollArgs, 'client'>): Promise<EdgePollResult> {
  return pollEdgeStatus({
    client: args.client,
    tenantId: args.tenantId ?? 'acme',
    statusEndpointKey: args.statusEndpointKey ?? 'organization.edge.getPingStatus',
    statusResponseFields: args.statusResponseFields ?? ['status', 'result'],
    query: args.query ?? { proxy_id: 'proxy-1', device_ip: '192.168.1.10' },
    options: args.options,
    sleeper: args.sleeper,
    now: args.now,
    random: args.random
  });
}

describe('edge poll helpers', () => {
  it('honors HTTP-date Retry-After values using the injected clock', async () => {
    const clock = controlledClock();
    const sleepCalls: number[] = [];
    const retryAt = new Date(clock.now() + 5_000).toUTCString();
    const client = buildClient([
      { ok: false, status: 429, detail: 'rate limited', headers: { 'retry-after': retryAt } },
      { ok: true, data: { status: 'success' } }
    ]);

    const result = await runPoll({
      client,
      now: clock.now,
      sleeper: async (ms) => {
        sleepCalls.push(ms);
        clock.advance(ms);
      }
    });

    expect(sleepCalls[0]).toBe(5_000);
    expect(result.outcome).toBe('success');
  });

  it('rejects non-numeric positive-int inputs', () => {
    expect(() => parsePositiveInt('10s', 'edge_poll_timeout_ms')).toThrow(/positive integer/);
    expect(() => parsePositiveInt('2e3', 'edge_poll_interval_ms')).toThrow(/positive integer/);
  });
});
