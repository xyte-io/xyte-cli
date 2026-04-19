import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { XyteHttpError } from '../src/http/errors';
import {
  batchExitedClean,
  runEdgeClaim,
  runEdgeClaimBatch,
  validateEdgeClaimRow,
  type EdgeClaimRow
} from '../src/workflows/edge-claim';
import { EdgeProbeAbortError } from '../src/workflows/edge-poll';
import type { XyteCallArgs, XyteCallResult, XyteClient } from '../src/types/client';

type ScriptedResponse =
  | { ok: true; data: unknown }
  | { ok: false; status: number; detail: string; headers?: Record<string, string> };

interface CallRecord {
  endpointKey: string;
  args: XyteCallArgs | undefined;
}

function buildClientFromScript(
  scriptByKey: Record<string, ScriptedResponse[]>
): { client: XyteClient; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const cursors: Record<string, number> = {};
  const callWithMeta = async <T = unknown>(
    endpointKey: string,
    args?: XyteCallArgs
  ): Promise<XyteCallResult<T>> => {
    calls.push({ endpointKey, args });
    const queue = scriptByKey[endpointKey];
    if (!queue || queue.length === 0) {
      throw new Error(`No scripted response for ${endpointKey}`);
    }
    const index = cursors[endpointKey] ?? 0;
    const next = queue[Math.min(index, queue.length - 1)];
    cursors[endpointKey] = index + 1;
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
      endpointKey,
      details: { detail: next.detail },
      headers: next.headers
    });
  };

  const stub = {
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
  return { client: stub as unknown as XyteClient, calls };
}

function makeRow(overrides: Partial<EdgeClaimRow> = {}): EdgeClaimRow {
  return {
    rowIndex: overrides.rowIndex ?? 1,
    proxy_id: overrides.proxy_id ?? 'proxy-1',
    device_ip: overrides.device_ip ?? '192.168.1.10',
    device_model_id: overrides.device_model_id ?? 'model-1',
    space_id: overrides.space_id ?? 99,
    ...overrides
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'edge-claim-runner-'));
}

function controlledClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_700_000_000_000;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    }
  };
}

describe('runEdgeClaim edge-case matrix', () => {
  it('happy path: pending → success returns succeeded outcome', async () => {
    const clock = controlledClock();
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [{ ok: true, data: null }],
      'organization.edge.getClaimStatus': [
        { ok: true, data: { result: 'pending' } },
        { ok: true, data: { result: 'pending' } },
        { ok: true, data: { result: 'success' } }
      ]
    });
    const sleeper = async (ms: number) => clock.advance(ms);

    const outcome = await runEdgeClaim({
      client,
      tenantId: 'acme',
      row: makeRow(),
      pollOptions: { intervalMs: 10, timeoutMs: 10_000 },
      sleeper,
      now: clock.now
    });

    expect(outcome.disposition).toBe('succeeded');
    expect(outcome.attempts).toBe(3);
    expect(outcome.lastState).toBe('success');
  });

  it('case 1: stays pending past timeoutMs → timeout with last payload preserved', async () => {
    const clock = controlledClock();
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [{ ok: true, data: null }],
      'organization.edge.getClaimStatus': [
        { ok: true, data: { result: 'pending' } }
      ]
    });
    const sleeper = async (ms: number) => clock.advance(ms);

    const outcome = await runEdgeClaim({
      client,
      tenantId: 'acme',
      row: makeRow(),
      pollOptions: { intervalMs: 50, timeoutMs: 120 },
      sleeper,
      now: clock.now
    });

    expect(outcome.disposition).toBe('timeout');
    expect(outcome.response).toEqual({ result: 'pending' });
  });

  it('case 2: terminal failed state returns failed disposition', async () => {
    const clock = controlledClock();
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [{ ok: true, data: null }],
      'organization.edge.getClaimStatus': [{ ok: true, data: { result: 'failed' } }]
    });

    const outcome = await runEdgeClaim({
      client,
      tenantId: 'acme',
      row: makeRow(),
      pollOptions: { intervalMs: 1, timeoutMs: 1_000 },
      sleeper: async () => undefined,
      now: clock.now
    });

    expect(outcome.disposition).toBe('failed');
    expect(outcome.lastState).toBe('failed');
  });

  it('case 3: startClaim 422 → rejected, no poll performed', async () => {
    const { client, calls } = buildClientFromScript({
      'organization.edge.startClaim': [
        { ok: false, status: 422, detail: 'unknown device_model_id' }
      ]
    });

    const outcome = await runEdgeClaim({
      client,
      tenantId: 'acme',
      row: makeRow(),
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(outcome.disposition).toBe('rejected');
    expect(outcome.detail).toContain('unknown device_model_id');
    expect(calls.every((call) => call.endpointKey !== 'organization.edge.getClaimStatus')).toBe(true);
  });

  it('classifies transient startClaim failures as failed instead of rejected', async () => {
    const { client, calls } = buildClientFromScript({
      'organization.edge.startClaim': [
        { ok: false, status: 429, detail: 'rate limited' }
      ]
    });

    const outcome = await runEdgeClaim({
      client,
      tenantId: 'acme',
      row: makeRow(),
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(outcome.disposition).toBe('failed');
    expect(outcome.detail).toContain('rate limited');
    expect(calls.every((call) => call.endpointKey !== 'organization.edge.getClaimStatus')).toBe(true);
  });

  it('case 4: startClaim 401 → EdgeProbeAbortError bubbles up', async () => {
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [
        { ok: false, status: 401, detail: 'bad org key' }
      ]
    });

    await expect(
      runEdgeClaim({
        client,
        tenantId: 'acme',
        row: makeRow(),
        sleeper: async () => undefined,
        now: () => 0
      })
    ).rejects.toBeInstanceOf(EdgeProbeAbortError);
  });

  it('case 6: proxy-offline detail → proxy-offline disposition', async () => {
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [
        { ok: false, status: 422, detail: 'Edge offline — proxy unreachable.' }
      ]
    });

    const outcome = await runEdgeClaim({
      client,
      tenantId: 'acme',
      row: makeRow(),
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(outcome.disposition).toBe('proxy-offline');
  });

  it('case 5: duplicate claim detail → already-claimed disposition', async () => {
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [
        { ok: false, status: 409, detail: 'Device already claimed on this edge.' }
      ]
    });

    const outcome = await runEdgeClaim({
      client,
      tenantId: 'acme',
      row: makeRow(),
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(outcome.disposition).toBe('already-claimed');
  });

  it('case 12: poll tolerates 422 "not initiated" within bounded count, then succeeds', async () => {
    const clock = controlledClock();
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [{ ok: true, data: null }],
      'organization.edge.getClaimStatus': [
        { ok: false, status: 422, detail: 'claim not initiated for this device_ip' },
        { ok: false, status: 422, detail: 'claim not initiated for this device_ip' },
        { ok: true, data: { result: 'success' } }
      ]
    });
    const sleeper = async (ms: number) => clock.advance(ms);

    const outcome = await runEdgeClaim({
      client,
      tenantId: 'acme',
      row: makeRow(),
      pollOptions: { intervalMs: 10, timeoutMs: 10_000, notInitiatedToleranceCount: 3 },
      sleeper,
      now: clock.now
    });

    expect(outcome.disposition).toBe('succeeded');
    expect(outcome.attempts).toBe(3);
  });

  it('case 12b: poll 422 "not initiated" beyond tolerance → failed row error', async () => {
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [{ ok: true, data: null }],
      'organization.edge.getClaimStatus': [
        { ok: false, status: 422, detail: 'claim not initiated for this device_ip' }
      ]
    });

    const outcome = await runEdgeClaim({
      client,
      tenantId: 'acme',
      row: makeRow(),
      pollOptions: { intervalMs: 1, timeoutMs: 1_000, notInitiatedToleranceCount: 0 },
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(outcome.disposition).toBe('failed');
    expect(outcome.attempts).toBe(1);
  });

  it('case 11: 429 with Retry-After honored, then success', async () => {
    const clock = controlledClock();
    const sleepCalls: number[] = [];
    const sleeper = async (ms: number) => {
      sleepCalls.push(ms);
      clock.advance(ms);
    };
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [{ ok: true, data: null }],
      'organization.edge.getClaimStatus': [
        { ok: false, status: 429, detail: 'Too Many Requests', headers: { 'retry-after': '2' } },
        { ok: true, data: { result: 'success' } }
      ]
    });

    const outcome = await runEdgeClaim({
      client,
      tenantId: 'acme',
      row: makeRow(),
      pollOptions: { intervalMs: 10, timeoutMs: 30_000 },
      sleeper,
      now: clock.now
    });

    expect(outcome.disposition).toBe('succeeded');
    expect(sleepCalls[0]).toBe(2_000);
  });

  it('case 11b: 429 beyond retry ceiling → failed', async () => {
    const clock = controlledClock();
    const sleeper = async (ms: number) => clock.advance(ms);
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [{ ok: true, data: null }],
      'organization.edge.getClaimStatus': [
        { ok: false, status: 429, detail: 'rate limited' },
        { ok: false, status: 429, detail: 'rate limited' },
        { ok: false, status: 429, detail: 'rate limited' }
      ]
    });

    const outcome = await runEdgeClaim({
      client,
      tenantId: 'acme',
      row: makeRow(),
      pollOptions: {
        intervalMs: 1,
        timeoutMs: 30_000,
        rateLimitMaxRetries: 2,
        rateLimitBaseBackoffMs: 10,
        rateLimitCeilingMs: 100
      },
      sleeper,
      now: clock.now,
      random: () => 0
    });

    expect(outcome.disposition).toBe('failed');
    expect(outcome.detail).toContain('rate limited');
    expect(outcome.attempts).toBe(3);
  });
});

describe('runEdgeClaimBatch edge-case matrix', () => {
  const CSV_HEADER = 'proxy_id,device_ip,device_model_id,space_id';
  function writeCsv(tmp: string, body: string): string {
    const file = join(tmp, 'edge-claim-primary.csv');
    writeFileSync(file, body, 'utf8');
    return file;
  }

  it('case 16: plan mode issues zero API calls and marks every row skipped', async () => {
    const tmp = makeTempDir();
    const inputPath = writeCsv(
      tmp,
      [CSV_HEADER, 'proxy-1,192.168.1.10,model-1,99', 'proxy-1,192.168.1.11,model-1,99'].join('\n')
    );
    const { client, calls } = buildClientFromScript({});

    const result = await runEdgeClaimBatch({
      client,
      tenantId: 'acme',
      inputPath,
      apply: false,
      runId: 'run-plan',
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(calls).toHaveLength(0);
    expect(result.mode).toBe('plan');
    expect(result.totals).toMatchObject({ rows: 2, skipped: 2, succeeded: 0 });
    expect(result.rows.every((row) => row.disposition === 'skipped')).toBe(true);
    expect(batchExitedClean(result)).toBe(true);
  });

  it('case 8 + 10: mixes rejected-at-validation + terminal success; batch is not clean', async () => {
    const tmp = makeTempDir();
    const inputPath = writeCsv(
      tmp,
      [
        CSV_HEADER,
        'proxy-1,192.168.1.10,model-1,99',
        ',192.168.1.11,model-1,99',
        'proxy-1,192.168.1.12,model-1,99'
      ].join('\n')
    );
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [
        { ok: true, data: null },
        { ok: true, data: null }
      ],
      'organization.edge.getClaimStatus': [
        { ok: true, data: { result: 'success' } },
        { ok: true, data: { result: 'success' } }
      ]
    });

    const result = await runEdgeClaimBatch({
      client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      runId: 'run-mixed',
      pollOptions: { intervalMs: 1, timeoutMs: 1_000 },
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(result.totals.rows).toBe(3);
    expect(result.totals.succeeded).toBe(2);
    expect(result.totals.rejected).toBe(1);
    const rejected = result.rows.find((row) => row.disposition === 'rejected');
    expect(rejected?.rejectReason).toContain('proxy_id is required');
    expect(batchExitedClean(result)).toBe(false);
  });

  it('case 4: 401 during row 1 aborts the remaining rows', async () => {
    const tmp = makeTempDir();
    const inputPath = writeCsv(
      tmp,
      [
        CSV_HEADER,
        'proxy-1,192.168.1.10,model-1,99',
        'proxy-1,192.168.1.11,model-1,99'
      ].join('\n')
    );
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [
        { ok: false, status: 401, detail: 'bad org key' }
      ]
    });

    const result = await runEdgeClaimBatch({
      client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      runId: 'run-abort',
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(result.stoppedEarly).toBe(true);
    expect(result.totals.aborted).toBe(2);
    expect(result.abortDetail).toContain('bad org key');
    expect(batchExitedClean(result)).toBe(false);
  });

  it('case 9 + 19: resume NDJSON skips rows already terminal-succeeded', async () => {
    const tmp = makeTempDir();
    const inputPath = writeCsv(
      tmp,
      [
        CSV_HEADER,
        'proxy-1,192.168.1.10,model-1,99',
        'proxy-1,192.168.1.11,model-1,99'
      ].join('\n')
    );
    const resumePath = join(tmp, 'resume.ndjson');
    writeFileSync(
      resumePath,
      `${JSON.stringify({
        rowIndex: 1,
        proxy_id: 'proxy-1',
        device_ip: '192.168.1.10',
        disposition: 'succeeded'
      })}\n`,
      'utf8'
    );
    const { client, calls } = buildClientFromScript({
      'organization.edge.startClaim': [{ ok: true, data: null }],
      'organization.edge.getClaimStatus': [{ ok: true, data: { result: 'success' } }]
    });

    const result = await runEdgeClaimBatch({
      client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      runId: 'run-resume',
      resumePath,
      pollOptions: { intervalMs: 1, timeoutMs: 1_000 },
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(result.rows[0]?.disposition).toBe('skipped');
    expect(result.rows[1]?.disposition).toBe('succeeded');
    expect(calls.filter((call) => call.endpointKey === 'organization.edge.startClaim')).toHaveLength(1);
    expect(
      calls[0]?.args?.body && (calls[0].args.body as Record<string, unknown>).device_ip
    ).toBe('192.168.1.11');
  });

  it('matches resume rows by device identity instead of row number alone', async () => {
    const tmp = makeTempDir();
    const inputPath = writeCsv(
      tmp,
      [
        CSV_HEADER,
        'proxy-2,10.0.0.50,model-1,99',
        'proxy-1,192.168.1.10,model-1,99'
      ].join('\n')
    );
    const resumePath = join(tmp, 'resume.ndjson');
    writeFileSync(
      resumePath,
      `${JSON.stringify({
        rowIndex: 1,
        proxy_id: 'proxy-1',
        device_ip: '192.168.1.10',
        disposition: 'succeeded'
      })}\n`,
      'utf8'
    );
    const { client, calls } = buildClientFromScript({
      'organization.edge.startClaim': [{ ok: true, data: null }],
      'organization.edge.getClaimStatus': [{ ok: true, data: { result: 'success' } }]
    });

    const result = await runEdgeClaimBatch({
      client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      runId: 'run-resume-identity',
      resumePath,
      pollOptions: { intervalMs: 1, timeoutMs: 1_000 },
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(result.rows[0]?.disposition).toBe('succeeded');
    expect(result.rows[1]?.disposition).toBe('skipped');
    expect(calls.filter((call) => call.endpointKey === 'organization.edge.startClaim')).toHaveLength(1);
    expect(
      calls[0]?.args?.body && (calls[0].args.body as Record<string, unknown>).device_ip
    ).toBe('10.0.0.50');
  });

  it('fails closed when the resume artifact contains a malformed line', async () => {
    const tmp = makeTempDir();
    const inputPath = writeCsv(tmp, [CSV_HEADER, 'proxy-1,192.168.1.10,model-1,99'].join('\n'));
    const resumePath = join(tmp, 'resume.ndjson');
    writeFileSync(
      resumePath,
      `${JSON.stringify({
        rowIndex: 1,
        proxy_id: 'proxy-1',
        device_ip: '192.168.1.10',
        disposition: 'succeeded'
      })}\n{"rowIndex":2`,
      'utf8'
    );
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': []
    });

    await expect(
      runEdgeClaimBatch({
        client,
        tenantId: 'acme',
        inputPath,
        apply: true,
        runId: 'run-malformed-resume',
        resumePath,
        pollOptions: { intervalMs: 1, timeoutMs: 1_000 },
        sleeper: async () => undefined,
        now: () => 0
      })
    ).rejects.toThrow(/Resume artifact .* malformed at line 2/);
  });

  it('skips duplicate device identities after they succeed earlier in the same run', async () => {
    const tmp = makeTempDir();
    const inputPath = writeCsv(
      tmp,
      [
        CSV_HEADER,
        'proxy-1,192.168.1.10,model-1,99',
        'proxy-1,192.168.1.10,model-1,99'
      ].join('\n')
    );
    const { client, calls } = buildClientFromScript({
      'organization.edge.startClaim': [{ ok: true, data: null }],
      'organization.edge.getClaimStatus': [{ ok: true, data: { result: 'success' } }]
    });

    const result = await runEdgeClaimBatch({
      client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      runId: 'run-duplicate-device',
      pollOptions: { intervalMs: 1, timeoutMs: 1_000 },
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(result.rows[0]?.disposition).toBe('succeeded');
    expect(result.rows[1]?.disposition).toBe('skipped');
    expect(calls.filter((call) => call.endpointKey === 'organization.edge.startClaim')).toHaveLength(1);
  });

  it('case 15: mixed-proxy batch processes every proxy independently', async () => {
    const tmp = makeTempDir();
    const inputPath = writeCsv(
      tmp,
      [
        CSV_HEADER,
        'proxy-1,192.168.1.10,model-1,99',
        'proxy-2,10.0.0.50,model-1,99',
        'proxy-1,192.168.1.12,model-1,99'
      ].join('\n')
    );
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [
        { ok: true, data: null },
        { ok: true, data: null },
        { ok: true, data: null }
      ],
      'organization.edge.getClaimStatus': [
        { ok: true, data: { result: 'success' } },
        { ok: true, data: { result: 'success' } },
        { ok: true, data: { result: 'success' } }
      ]
    });

    const result = await runEdgeClaimBatch({
      client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      runId: 'run-mixed-proxy',
      pollOptions: { intervalMs: 1, timeoutMs: 1_000 },
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(result.totals.succeeded).toBe(3);
    const proxies = new Set(result.rows.map((row) => row.proxy_id));
    expect(proxies).toEqual(new Set(['proxy-1', 'proxy-2']));
  });

  it('writes per-row NDJSON report when reportPath is supplied', async () => {
    const tmp = makeTempDir();
    const inputPath = writeCsv(tmp, [CSV_HEADER, 'proxy-1,192.168.1.10,model-1,99'].join('\n'));
    const reportPath = join(tmp, 'report.ndjson');
    const { client } = buildClientFromScript({
      'organization.edge.startClaim': [{ ok: true, data: null }],
      'organization.edge.getClaimStatus': [{ ok: true, data: { result: 'success' } }]
    });

    await runEdgeClaimBatch({
      client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      runId: 'run-report',
      reportPath,
      pollOptions: { intervalMs: 1, timeoutMs: 1_000 },
      sleeper: async () => undefined,
      now: () => 0
    });

    const lines = readFileSync(reportPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(parsed.disposition).toBe('succeeded');
    expect(parsed.runId).toBe('run-report');
  });

  it('preserves prior report lines when resuming with a shared report artifact', async () => {
    const tmp = makeTempDir();
    const inputPath = writeCsv(
      tmp,
      [
        CSV_HEADER,
        'proxy-1,192.168.1.10,model-1,99',
        'proxy-1,192.168.1.11,model-1,99'
      ].join('\n')
    );
    const artifactPath = join(tmp, 'edge-claim.ndjson');
    writeFileSync(
      artifactPath,
      `${JSON.stringify({
        rowIndex: 1,
        proxy_id: 'proxy-1',
        device_ip: '192.168.1.10',
        disposition: 'succeeded',
        detail: 'preserved'
      })}\n`,
      'utf8'
    );
    const firstRun = buildClientFromScript({
      'organization.edge.startClaim': [{ ok: true, data: null }],
      'organization.edge.getClaimStatus': [{ ok: true, data: { result: 'success' } }]
    });

    const resumed = await runEdgeClaimBatch({
      client: firstRun.client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      runId: 'run-shared-artifact',
      reportPath: artifactPath,
      resumePath: artifactPath,
      pollOptions: { intervalMs: 1, timeoutMs: 1_000 },
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(resumed.rows[0]?.disposition).toBe('skipped');
    expect(firstRun.calls.filter((call) => call.endpointKey === 'organization.edge.startClaim')).toHaveLength(1);
    const afterResume = readFileSync(artifactPath, 'utf8');
    expect(afterResume).toContain('"detail":"preserved"');

    const secondRun = buildClientFromScript({
      'organization.edge.startClaim': []
    });
    const repeated = await runEdgeClaimBatch({
      client: secondRun.client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      runId: 'run-shared-artifact-repeat',
      reportPath: artifactPath,
      resumePath: artifactPath,
      pollOptions: { intervalMs: 1, timeoutMs: 1_000 },
      sleeper: async () => undefined,
      now: () => 0
    });

    expect(repeated.rows.every((row) => row.disposition === 'skipped')).toBe(true);
    expect(secondRun.calls).toHaveLength(0);
  });
});

describe('validateEdgeClaimRow', () => {
  it('rejects rows missing required columns with a specific reason', () => {
    const result = validateEdgeClaimRow({ device_ip: '1.2.3.4' }, 2);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('proxy_id is required');
  });

  it('rejects non-positive space_id', () => {
    const result = validateEdgeClaimRow(
      { proxy_id: 'p', device_ip: '1.2.3.4', device_model_id: 'm', space_id: 'not-a-number' },
      3
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('space_id must be a positive integer');
  });

  it('rejects malformed custom_parameters JSON', () => {
    const result = validateEdgeClaimRow(
      {
        proxy_id: 'p',
        device_ip: '1.2.3.4',
        device_model_id: 'm',
        space_id: 1,
        custom_parameters: '{not: valid'
      },
      4
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('valid JSON');
  });

  it('rejects malformed skip_connectivity_check literals', () => {
    const result = validateEdgeClaimRow(
      {
        proxy_id: 'p',
        device_ip: '1.2.3.4',
        device_model_id: 'm',
        space_id: 1,
        skip_connectivity_check: 'yes'
      },
      5
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('true or false');
  });

  it('accepts a row with only the required fields', () => {
    const result = validateEdgeClaimRow(
      { proxy_id: 'p', device_ip: '1.2.3.4', device_model_id: 'm', space_id: '12' },
      6
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.row.space_id).toBe(12);
  });
});
