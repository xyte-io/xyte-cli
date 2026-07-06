import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { XyteHttpError } from '../src/http/errors';
import type { XyteCallArgs, XyteCallResult, XyteClient } from '../src/types/client';
import {
  runEdgeParamsUpdate,
  runEdgeParamsUpdateBatch
} from '../src/workflows/edge-params-update';

type ScriptedResponse =
  | { ok: true; data: unknown }
  | { ok: false; status: number; detail: string; headers?: Record<string, string> };

interface CallRecord {
  endpointKey: string;
  args: XyteCallArgs | undefined;
}

function buildClientFromScript(scriptByKey: Record<string, ScriptedResponse[]>): {
  client: XyteClient;
  calls: CallRecord[];
} {
  const calls: CallRecord[] = [];
  const cursors: Record<string, number> = {};
  const callWithMeta = async <T = unknown>(endpointKey: string, args?: XyteCallArgs): Promise<XyteCallResult<T>> => {
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

function device(
  custom_parameters: Record<string, unknown> = { 'SNMP community': 'public', Port: '162' }
): Record<string, unknown> {
  return {
    id: 'dev-1',
    model: { id: 'model-1' },
    custom_parameters
  };
}

function model(parameters = [
  { name: 'SNMP community', type: 'text', required: true },
  { name: 'Port', type: 'number', required: false },
  { name: 'Password', type: 'password', required: false }
]): unknown {
  return {
    id: 'model-1',
    vendor: 'Acme',
    model: 'Sensor 100',
    parameters
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'edge-params-update-'));
}

function readNdjson(path: string): Array<Record<string, unknown>> {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('runEdgeParamsUpdate', () => {
  it('plans a full replacement by merging set_json into current custom_parameters', async () => {
    const { client, calls } = buildClientFromScript({
      'organization.devices.getDevice': [{ ok: true, data: device() }],
      'organization.models.getModel': [{ ok: true, data: model() }]
    });

    const result = await runEdgeParamsUpdate({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      set: { Port: '161' },
      apply: false
    });

    expect(result.outcome.disposition).toBe('planned');
    expect(result.outcome.plan?.requestBody).toEqual({
      custom_parameters: {
        'SNMP community': 'public',
        Port: '161'
      }
    });
    expect(calls.map((call) => call.endpointKey)).toEqual([
      'organization.devices.getDevice',
      'organization.models.getModel'
    ]);
  });

  it('rejects parameter keys that are not declared on the current model', async () => {
    const { client } = buildClientFromScript({
      'organization.devices.getDevice': [{ ok: true, data: device() }],
      'organization.models.getModel': [{ ok: true, data: model() }]
    });

    const result = await runEdgeParamsUpdate({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      set: { Unknown: true },
      apply: false
    });

    expect(result.outcome.disposition).toBe('rejected');
    expect(result.outcome.rejectReason).toBe('unknown_parameter');
  });

  it('rejects unsupported existing custom_parameters before planning the replacement body', async () => {
    const { client } = buildClientFromScript({
      'organization.devices.getDevice': [{ ok: true, data: device({ 'SNMP community': 'public', Stale: true }) }],
      'organization.models.getModel': [{ ok: true, data: model() }]
    });

    const result = await runEdgeParamsUpdate({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      set: { Port: '161' },
      apply: false
    });

    expect(result.outcome.disposition).toBe('rejected');
    expect(result.outcome.rejectReason).toBe('unsupported_current_parameter');
  });

  it('rejects missing required parameters in the final replacement body', async () => {
    const { client } = buildClientFromScript({
      'organization.devices.getDevice': [{ ok: true, data: device({ Port: '162' }) }],
      'organization.models.getModel': [{ ok: true, data: model() }]
    });

    const result = await runEdgeParamsUpdate({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      set: { Port: '161' },
      apply: false
    });

    expect(result.outcome.disposition).toBe('rejected');
    expect(result.outcome.rejectReason).toBe('missing_required_parameter');
  });

  it('rejects masked password preservation unless the user supplies a real replacement', async () => {
    const { client } = buildClientFromScript({
      'organization.devices.getDevice': [
        { ok: true, data: device({ 'SNMP community': 'public', Port: '162', Password: '*****' }) }
      ],
      'organization.models.getModel': [{ ok: true, data: model() }]
    });

    const result = await runEdgeParamsUpdate({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      set: { Port: '161' },
      apply: false
    });

    expect(result.outcome.disposition).toBe('rejected');
    expect(result.outcome.rejectReason).toBe('masked_password_requires_value');
  });

  it('rejects masked password values in set_json', async () => {
    const { client } = buildClientFromScript({
      'organization.devices.getDevice': [{ ok: true, data: device({ 'SNMP community': 'public', Port: '162' }) }],
      'organization.models.getModel': [{ ok: true, data: model() }]
    });

    const result = await runEdgeParamsUpdate({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      set: { Password: '*****' },
      apply: false
    });

    expect(result.outcome.disposition).toBe('rejected');
    expect(result.outcome.rejectReason).toBe('masked_password_requires_value');
  });

  it('rejects when expected_model_id does not match the current device model', async () => {
    const { client } = buildClientFromScript({
      'organization.devices.getDevice': [{ ok: true, data: device() }]
    });

    const result = await runEdgeParamsUpdate({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      set: { Port: '161' },
      expectedModelId: 'model-2',
      apply: false
    });

    expect(result.outcome.disposition).toBe('rejected');
    expect(result.outcome.rejectReason).toBe('model_mismatch');
  });

  it('applies updateDevice with the complete replacement object and verifies read-back', async () => {
    const { client, calls } = buildClientFromScript({
      'organization.devices.getDevice': [
        { ok: true, data: device() },
        { ok: true, data: device({ 'SNMP community': 'public', Port: '161' }) }
      ],
      'organization.models.getModel': [{ ok: true, data: model() }],
      'organization.devices.updateDevice': [{ ok: true, data: { ok: true } }]
    });

    const result = await runEdgeParamsUpdate({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      set: { Port: '161' },
      apply: true
    });

    expect(result.outcome.disposition).toBe('succeeded');
    const updateCall = calls.find((call) => call.endpointKey === 'organization.devices.updateDevice');
    expect(updateCall?.args).toMatchObject({
      path: { device_id: 'dev-1' },
      body: {
        custom_parameters: {
          'SNMP community': 'public',
          Port: '161'
        }
      }
    });
    expect(result.outcome.verification?.ok).toBe(true);
  });

  it('fails when read-back verification does not match the planned replacement', async () => {
    const { client } = buildClientFromScript({
      'organization.devices.getDevice': [
        { ok: true, data: device() },
        { ok: true, data: device({ 'SNMP community': 'public', Port: '162' }) }
      ],
      'organization.models.getModel': [{ ok: true, data: model() }],
      'organization.devices.updateDevice': [{ ok: true, data: { ok: true } }]
    });

    const result = await runEdgeParamsUpdate({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      set: { Port: '161' },
      apply: true
    });

    expect(result.outcome.disposition).toBe('failed');
    expect(result.outcome.verification?.mismatches).toEqual([{ key: 'Port', expected: '161', actual: '162' }]);
  });
});

describe('runEdgeParamsUpdateBatch', () => {
  it('plans rows, writes an NDJSON report, and records row-level rejections', async () => {
    const root = tempDir();
    const inputPath = join(root, 'rows.csv');
    const reportPath = join(root, 'report.ndjson');
    writeFileSync(inputPath, 'device_id,set_json\n' + 'dev-1,"{""Port"":""161""}"\n' + 'dev-2,"{""Unknown"":true}"\n');
    const { client } = buildClientFromScript({
      'organization.devices.getDevice': [
        { ok: true, data: device() },
        { ok: true, data: { ...device(), id: 'dev-2' } }
      ],
      'organization.models.getModel': [
        { ok: true, data: model() },
        { ok: true, data: model() }
      ]
    });

    const result = await runEdgeParamsUpdateBatch({
      client,
      tenantId: 'acme',
      inputPath,
      apply: false,
      reportPath
    });

    expect(result.totals).toMatchObject({ rows: 2, planned: 1, rejected: 1 });
    expect(readNdjson(reportPath).map((row) => row.disposition)).toEqual(['planned', 'rejected']);
  });

  it('reports missing_set_json separately from invalid_set_json', async () => {
    const root = tempDir();
    const inputPath = join(root, 'rows.csv');
    writeFileSync(
      inputPath,
      'device_id,set_json\n' + 'dev-1,\n' + 'dev-2,"[]"\n' + 'dev-3,"{not valid json"\n'
    );
    const { client } = buildClientFromScript({});

    const result = await runEdgeParamsUpdateBatch({
      client,
      tenantId: 'acme',
      inputPath,
      apply: false
    });

    expect(result.totals).toMatchObject({ rows: 3, rejected: 3 });
    expect(result.rows.map((row) => row.rejectReason)).toEqual([
      'missing_set_json',
      'invalid_set_json',
      'invalid_set_json'
    ]);
  });

  it('writes resume entries on apply and skips previously succeeded rows', async () => {
    const root = tempDir();
    const inputPath = join(root, 'rows.csv');
    const reportPath = join(root, 'report.ndjson');
    const resumePath = join(root, 'resume.ndjson');
    writeFileSync(inputPath, 'device_id,set_json\n' + 'dev-1,"{""Port"":""161""}"\n');
    const first = buildClientFromScript({
      'organization.devices.getDevice': [
        { ok: true, data: device() },
        { ok: true, data: device({ 'SNMP community': 'public', Port: '161' }) }
      ],
      'organization.models.getModel': [{ ok: true, data: model() }],
      'organization.devices.updateDevice': [{ ok: true, data: { ok: true } }]
    });

    await runEdgeParamsUpdateBatch({
      client: first.client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      reportPath,
      resumePath
    });
    expect(readNdjson(resumePath)[0]?.disposition).toBe('succeeded');

    const second = buildClientFromScript({});
    const resumed = await runEdgeParamsUpdateBatch({
      client: second.client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      reportPath,
      resumePath
    });

    expect(resumed.totals).toMatchObject({ rows: 1, skipped: 1 });
    expect(second.calls).toHaveLength(0);
  });

  it('rejects duplicate-device rows instead of applying multiple full replacements', async () => {
    const root = tempDir();
    const inputPath = join(root, 'rows.csv');
    const reportPath = join(root, 'report.ndjson');
    writeFileSync(
      inputPath,
      'device_id,set_json\n' + 'dev-1,"{""Port"":""161""}"\n' + 'dev-1,"{""Port"":""162""}"\n'
    );
    const firstRow = buildClientFromScript({
      'organization.devices.getDevice': [
        { ok: true, data: device() },
        { ok: true, data: device({ 'SNMP community': 'public', Port: '161' }) }
      ],
      'organization.models.getModel': [{ ok: true, data: model() }],
      'organization.devices.updateDevice': [{ ok: true, data: { ok: true } }]
    });

    const result = await runEdgeParamsUpdateBatch({
      client: firstRow.client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      reportPath
    });

    expect(result.totals).toMatchObject({ rows: 2, succeeded: 1, rejected: 1 });
    expect(result.rows.map((row) => row.disposition)).toEqual(['succeeded', 'rejected']);
    expect(result.rows[1]?.rejectReason).toBe('duplicate_device_id');
    expect(firstRow.calls.map((call) => call.endpointKey)).toEqual([
      'organization.devices.getDevice',
      'organization.models.getModel',
      'organization.devices.updateDevice',
      'organization.devices.getDevice'
    ]);
  });

  it('rejects malformed resume disposition values', async () => {
    const root = tempDir();
    const inputPath = join(root, 'rows.csv');
    const resumePath = join(root, 'resume.ndjson');
    writeFileSync(inputPath, 'device_id,set_json\n' + 'dev-1,"{""Port"":""161""}"\n');
    writeFileSync(resumePath, '{"rowIndex":1,"device_id":"dev-1","disposition":"done"}\n');
    const { client } = buildClientFromScript({});

    await expect(
      runEdgeParamsUpdateBatch({
        client,
        tenantId: 'acme',
        inputPath,
        apply: true,
        resumePath
      })
    ).rejects.toThrow(/malformed/);
  });
});
