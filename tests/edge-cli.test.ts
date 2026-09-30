import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createCli } from '../src/cli/index';
import { MemorySecretStore } from '../src/secure/secret-store';
import { MemoryProfileStore } from './support/memory-profile-store';

async function bootstrapTenant(): Promise<{
  profileStore: MemoryProfileStore;
  secretStore: MemorySecretStore;
}> {
  const profileStore = new MemoryProfileStore();
  await profileStore.upsertTenant({ id: 'acme' });
  await profileStore.setActiveTenant('acme');
  const secretStore = new MemorySecretStore();
  await secretStore.setSecret('acme', 'xyte-org', 'org-key');
  return { profileStore, secretStore };
}

describe('edge command group', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('edge claim --plan prints plan payload after validating the model', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge claim plan test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'claim',
      '--tenant',
      'acme',
      '--proxy-id',
      'proxy-1',
      '--device-ip',
      '192.168.1.10',
      '--device-model-id',
      'model-1',
      '--space-id',
      '99',
      '--mac',
      'aa:bb:cc:dd:ee:ff',
      '--sn',
      'SN-12345',
      '--plan'
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/core/v1/organization/models/model-1');
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('xyte.edge.claim.plan.v1');
    expect(printed).toContain('proxy-1');
    expect(printed).toContain('192.168.1.10');
    expect(printed).toContain('"space_id": 99');
    expect(printed).toContain('aa:bb:cc:dd:ee:ff');
    expect(printed).toContain('SN-12345');
    const parsed = JSON.parse(printed) as { planned: Record<string, unknown>; supportedParameters: unknown[] };
    expect(parsed.planned).not.toHaveProperty('skip_connectivity_check');
    expect(parsed.supportedParameters).toEqual([]);
  });

  it('edge claim --plan includes skip_connectivity_check only when requested', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge claim skip plan test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'claim',
      '--tenant',
      'acme',
      '--proxy-id',
      'proxy-1',
      '--device-ip',
      '192.168.1.10',
      '--device-model-id',
      'model-1',
      '--space-id',
      '99',
      '--skip-connectivity-check',
      '--plan'
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    const parsed = JSON.parse(printed) as { planned: Record<string, unknown> };
    expect(parsed.planned.skip_connectivity_check).toBe(true);
  });

  it('edge claim --plan rejects custom_parameters missing required model params', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(
          JSON.stringify({
            id: 'model-1',
            parameters: [{ name: 'SNMP community', type: 'text', required: true }]
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      throw new Error(`Unexpected URL in edge claim required params test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'edge',
        'claim',
        '--tenant',
        'acme',
        '--proxy-id',
        'proxy-1',
        '--device-ip',
        '192.168.1.10',
        '--device-model-id',
        'model-1',
        '--space-id',
        '99',
        '--custom-parameters',
        '{}',
        '--plan'
      ])
    ).rejects.toThrow(/Required custom parameter/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('edge claim rejects malformed input before calling the API', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge claim-batch input-format test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'edge',
        'claim',
        '--tenant',
        'acme',
        '--proxy-id',
        'proxy-1',
        '--device-ip',
        '192.168.1.10',
        '--device-model-id',
        'model-1',
        '--space-id',
        'not-a-number',
        '--apply'
      ])
    ).rejects.toThrow(/Invalid edge claim input/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('edge claim refuses --plan and --apply at the same time', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    vi.stubGlobal('fetch', vi.fn());

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'edge',
        'claim',
        '--tenant',
        'acme',
        '--proxy-id',
        'proxy-1',
        '--device-ip',
        '192.168.1.10',
        '--device-model-id',
        'model-1',
        '--space-id',
        '99',
        '--plan',
        '--apply'
      ])
    ).rejects.toThrow(/--plan or --apply/);
  });

  it('edge ping defaults to --plan and emits planned payload without calling the API', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge claim-batch skip plan test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'ping',
      '--tenant',
      'acme',
      '--proxy-id',
      'proxy-1',
      '--device-ip',
      '192.168.1.10'
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('xyte.edge.ping.plan.v1');
    expect(printed).toContain('proxy-1');
  });

  it('edge ping honors global --output text in plan mode', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      '--output',
      'text',
      'edge',
      'ping',
      '--tenant',
      'acme',
      '--proxy-id',
      'proxy-1',
      '--device-ip',
      '192.168.1.10'
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('\n  "schemaVersion": "xyte.edge.ping.plan.v1"');
  });

  it('edge claim-batch honors --input-format for ambiguous input files', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge claim-batch input-format test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const tempDir = mkdtempSync(join(tmpdir(), 'xyte-edge-cli-'));
    const inputPath = join(tempDir, 'claims.csv');
    writeFileSync(
      inputPath,
      JSON.stringify([{ proxy_id: 'proxy-1', device_ip: '192.168.1.10', device_model_id: 'model-1', space_id: 99 }]),
      'utf8'
    );

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'claim-batch',
      '--tenant',
      'acme',
      '--input',
      inputPath,
      '--input-format',
      'json',
      '--plan'
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/core/v1/organization/models/model-1');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/start_claim'))).toBe(false);
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    const parsed = JSON.parse(printed) as { totals: { rows: number }; rows: Array<{ disposition: string }> };
    expect(parsed.totals.rows).toBe(1);
    expect(parsed.rows[0]?.disposition).toBe('skipped');
  });

  it('edge claim-batch --skip-connectivity-check plans true, blank, and false-conflict rows', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge claim-batch skip-connectivity plan test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const tempDir = mkdtempSync(join(tmpdir(), 'xyte-edge-cli-'));
    const inputPath = join(tempDir, 'claims.csv');
    writeFileSync(
      inputPath,
      [
        'proxy_id,device_ip,device_model_id,space_id,skip_connectivity_check',
        'proxy-1,192.168.1.10,model-1,99,true',
        'proxy-1,192.168.1.11,model-1,99,',
        'proxy-1,192.168.1.12,model-1,99,false'
      ].join('\n'),
      'utf8'
    );

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'claim-batch',
      '--tenant',
      'acme',
      '--input',
      inputPath,
      '--skip-connectivity-check',
      '--plan'
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/core/v1/organization/models/model-1');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/start_claim'))).toBe(false);
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    const parsed = JSON.parse(printed) as {
      rows: Array<{
        disposition?: string;
        rejectReason?: string;
        planned?: { preClaimPing?: string; claimBody?: Record<string, unknown> };
      }>;
    };
    expect(parsed.rows[0]?.planned?.preClaimPing).toBe('skipped');
    expect(parsed.rows[0]?.planned?.claimBody?.skip_connectivity_check).toBe(true);
    expect(parsed.rows[1]?.planned?.preClaimPing).toBe('skipped');
    expect(parsed.rows[1]?.planned?.claimBody?.skip_connectivity_check).toBe(true);
    expect(parsed.rows[2]?.disposition).toBe('rejected');
    expect(parsed.rows[2]?.rejectReason).toContain('conflicts with --skip-connectivity-check');
  });

  it('edge claim-batch --skip-connectivity-check --apply rejects explicit false conflicts and exits non-zero', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge claim-batch skip-connectivity apply conflict test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const tempDir = mkdtempSync(join(tmpdir(), 'xyte-edge-cli-'));
    const inputPath = join(tempDir, 'claims.csv');
    writeFileSync(
      inputPath,
      'proxy_id,device_ip,device_model_id,space_id,skip_connectivity_check\nproxy-1,192.168.1.10,model-1,99,false\n',
      'utf8'
    );

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'claim-batch',
      '--tenant',
      'acme',
      '--input',
      inputPath,
      '--skip-connectivity-check',
      '--apply'
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/core/v1/organization/models/model-1');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/start_claim'))).toBe(false);
    expect(process.exitCode).toBe(1);
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    const parsed = JSON.parse(printed) as { totals: { rejected: number }; rows: Array<{ disposition: string }> };
    expect(parsed.totals.rejected).toBe(1);
    expect(parsed.rows[0]?.disposition).toBe('rejected');
  });

  it('edge claim-batch --apply sets exit code when pre-claim ping fails', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const tempDir = mkdtempSync(join(tmpdir(), 'xyte-edge-cli-'));
    const inputPath = join(tempDir, 'claims.csv');
    writeFileSync(inputPath, 'proxy_id,device_ip,device_model_id,space_id\nproxy-1,192.168.1.10,model-1,99\n', 'utf8');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/core/v1/organization/edges/devices/start_ping')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/core/v1/organization/edges/devices/get_ping_status')) {
        return new Response(JSON.stringify({ status: 'failed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in ping-failed CLI test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'claim-batch',
      '--tenant',
      'acme',
      '--input',
      inputPath,
      '--apply',
      '--poll-interval-ms',
      '1',
      '--poll-timeout-ms',
      '1000'
    ]);

    expect(process.exitCode).toBe(1);
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    const parsed = JSON.parse(printed) as { totals: { pingFailed: number }; rows: Array<{ disposition: string }> };
    expect(parsed.totals.pingFailed).toBe(1);
    expect(parsed.rows[0]?.disposition).toBe('ping-failed');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/start_claim'))).toBe(false);
  });

  it('edge claim-batch sets exit code when rows end proxy-offline', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const tempDir = mkdtempSync(join(tmpdir(), 'xyte-edge-cli-'));
    const inputPath = join(tempDir, 'claims.csv');
    writeFileSync(inputPath, 'proxy_id,device_ip,device_model_id,space_id\nproxy-1,192.168.1.10,model-1,99\n', 'utf8');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/core/v1/organization/edges/devices/start_claim')) {
        return new Response(JSON.stringify({ detail: 'Edge offline — proxy unreachable.' }), {
          status: 422,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in proxy-offline CLI test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'claim-batch',
      '--tenant',
      'acme',
      '--input',
      inputPath,
      '--skip-connectivity-check',
      '--apply'
    ]);

    expect(process.exitCode).toBe(1);
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('proxy-offline');
  });

  it('edge ping rejects non-numeric poll timing values', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    vi.stubGlobal('fetch', vi.fn());

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'edge',
        'claim',
        '--tenant',
        'acme',
        '--proxy-id',
        'proxy-1',
        '--device-ip',
        '192.168.1.10',
        '--device-model-id',
        'model-1',
        '--space-id',
        '99',
        '--plan',
        '--poll-timeout-ms',
        '10s'
      ])
    ).rejects.toThrow(/positive integer/);
  });

  it('edge ping validates poll timing values in --plan mode', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    vi.stubGlobal('fetch', vi.fn());

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'edge',
        'ping',
        '--tenant',
        'acme',
        '--proxy-id',
        'proxy-1',
        '--device-ip',
        '192.168.1.10',
        '--plan',
        '--poll-timeout-ms',
        '10s'
      ])
    ).rejects.toThrow(/positive integer/);
  });

  it('edge models list calls getModels with edge_only and explicit pagination', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [{ id: 'model-1', model: 'Sensor' }], next_page: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'models',
      'list',
      '--tenant',
      'acme',
      '--search',
      'sensor',
      '--page',
      '2',
      '--per-page',
      '50'
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('/core/v1/organization/models');
    expect(url).toContain('edge_only=true');
    expect(url).toContain('search=sensor');
    expect(url).toContain('page=2');
    expect(url).toContain('per_page=50');
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('xyte.edge.models.list.v1');
    expect(printed).toContain('model-1');
    const parsed = JSON.parse(printed) as { query: Record<string, unknown>; response: Record<string, unknown> };
    expect(parsed.query).toMatchObject({ edge_only: true, search: 'sensor', page: 2, per_page: 50 });
    expect(parsed.response.next_page).toBeNull();
  });

  it('edge models describe calls getModel with model id path', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'model-1', parameters: [{ name: 'Port', type: 'number' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'models',
      'describe',
      '--tenant',
      'acme',
      '--model-id',
      'model-1'
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('/core/v1/organization/models/model-1');
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('xyte.edge.models.describe.v1');
    expect(printed).toContain('Port');
  });

  it('edge update-params --plan reads device/model and does not call updateDevice', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/devices/dev-1')) {
        expect(init?.method).toBe('GET');
        return new Response(
          JSON.stringify({
            id: 'dev-1',
            model: { id: 'model-1' },
            custom_parameters: { 'SNMP community': 'public', Port: '162' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/models/model-1')) {
        expect(init?.method).toBe('GET');
        return new Response(
          JSON.stringify({
            id: 'model-1',
            parameters: [
              { name: 'SNMP community', type: 'text' },
              { name: 'Port', type: 'number' }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'update-params',
      '--tenant',
      'acme',
      '--device-id',
      'dev-1',
      '--set-json',
      '{"Port":"161"}',
      '--plan'
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('xyte.edge.params-update.v1');
    expect(printed).toContain('"Port": "161"');
    expect(printed).toContain('"SNMP community": "public"');
  });

  it('edge claim-status calls organization.edge.getClaimStatus with query params', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: 'pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'claim-status',
      '--tenant',
      'acme',
      '--proxy-id',
      'proxy-1',
      '--device-ip',
      '192.168.1.10'
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('/core/v1/organization/edges/devices/get_claim_status');
    expect(url).toContain('proxy_id=proxy-1');
    expect(url).toContain('device_ip=192.168.1.10');

    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('xyte.edge.claim-status.v1');
    expect(printed).toContain('"result": "pending"');
  });

  it('edge claim-status honors global --output text', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ result: 'pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      '--output',
      'text',
      'edge',
      'claim-status',
      '--tenant',
      'acme',
      '--proxy-id',
      'proxy-1',
      '--device-ip',
      '192.168.1.10'
    ]);

    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('\n  "schemaVersion": "xyte.edge.claim-status.v1"');
    expect(printed).toContain('\n    "result": "pending"');
  });

  it('edge ping-status calls organization.edge.getPingStatus with query params', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'pending' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'ping-status',
      '--tenant',
      'acme',
      '--proxy-id',
      'proxy-1',
      '--device-ip',
      '192.168.1.10'
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('/core/v1/organization/edges/devices/get_ping_status');
    expect(url).toContain('proxy_id=proxy-1');
    expect(url).toContain('device_ip=192.168.1.10');

    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('xyte.edge.ping-status.v1');
  });
});
