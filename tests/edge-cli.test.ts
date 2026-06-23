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

  it('edge models calls organization.edges.getModels with search and pagination query params', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [{ id: 'model-1', model: 'Samsung QMC Series' }], next_page: null }), {
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
      '--tenant',
      'acme',
      '--search',
      'samsung',
      '--page',
      '2',
      '--per-page',
      '50'
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('/core/v1/organization/edges/models');
    expect(url).toContain('search=samsung');
    expect(url).toContain('page=2');
    expect(url).toContain('per_page=50');
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('xyte.edge.models.v1');
    expect(printed).toContain('Samsung QMC Series');
  });

  it('edge models rejects ambiguous search flags before calling the API', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'edge',
        'models',
        '--tenant',
        'acme',
        '--search',
        'samsung',
        '--q',
        'qmc'
      ])
    ).rejects.toThrow(/either --search or --q/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('edge model calls organization.edges.getModel with the path id', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'model-1',
          model: 'Samsung QMC Series',
          parameters: [{ name: '{$DEVICE_ID}', type: 'text', required: true }]
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync(['node', 'xyte-cli', 'edge', 'model', '--tenant', 'acme', 'model-1']);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('/core/v1/organization/edges/models/model-1');
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('xyte.edge.model.v1');
    expect(printed).toContain('{$DEVICE_ID}');
  });

  it('edge claim --plan prints plan payload without calling the API', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn();
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
      '--plan'
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('xyte.edge.claim.plan.v1');
    expect(printed).toContain('proxy-1');
    expect(printed).toContain('192.168.1.10');
    expect(printed).toContain('"space_id": 99');
    const parsed = JSON.parse(printed) as { planned: Record<string, unknown> };
    expect(parsed.planned).not.toHaveProperty('skip_connectivity_check');
  });

  it('edge claim --plan includes skip_connectivity_check only when requested', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn();
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

    expect(fetchMock).not.toHaveBeenCalled();
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    const parsed = JSON.parse(printed) as { planned: Record<string, unknown> };
    expect(parsed.planned.skip_connectivity_check).toBe(true);
  });

  it('edge claim rejects malformed input before calling the API', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn();
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
    const fetchMock = vi.fn();
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
    const fetchMock = vi.fn();
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

    expect(fetchMock).not.toHaveBeenCalled();
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    const parsed = JSON.parse(printed) as { totals: { rows: number }; rows: Array<{ disposition: string }> };
    expect(parsed.totals.rows).toBe(1);
    expect(parsed.rows[0]?.disposition).toBe('skipped');
  });

  it('edge claim-batch --skip-connectivity-check plans true, blank, and false-conflict rows', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn();
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

    expect(fetchMock).not.toHaveBeenCalled();
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
    const fetchMock = vi.fn();
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

    expect(fetchMock).not.toHaveBeenCalled();
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
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ detail: 'Edge offline — proxy unreachable.' }), {
        status: 422,
        headers: { 'content-type': 'application/json' }
      })
    );
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

  it('edge update-hostname --plan prints request shape without calling the API', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'edge',
      'update-hostname',
      '--tenant',
      'acme',
      '--device-id',
      'device-1',
      '--device-ip',
      '192.168.1.25',
      '--skip-connectivity-check',
      '--plan'
    ]);

    expect(fetchMock).not.toHaveBeenCalled();
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    const parsed = JSON.parse(printed) as {
      schemaVersion: string;
      planned: { path: { device_id: string }; body: { device_ip: string; skip_connectivity_check?: boolean } };
    };
    expect(parsed.schemaVersion).toBe('xyte.edge.update-hostname.plan.v1');
    expect(parsed.planned.path.device_id).toBe('device-1');
    expect(parsed.planned.body.device_ip).toBe('192.168.1.25');
    expect(parsed.planned.body.skip_connectivity_check).toBe(true);
  });

  it('edge update-hostname --apply calls organization.edge.updateHostname with path and body', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
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
      'update-hostname',
      '--tenant',
      'acme',
      '--device-id',
      'device-1',
      '--device-ip',
      'display-01.local',
      '--apply'
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/core/v1/organization/edges/devices/device-1/update_hostname');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ device_ip: 'display-01.local' });
    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('xyte.edge.update-hostname.v1');
    expect(printed).toContain('"success": true');
  });

  it('edge update-hostname refuses --plan and --apply at the same time', async () => {
    const { profileStore, secretStore } = await bootstrapTenant();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'edge',
        'update-hostname',
        '--tenant',
        'acme',
        '--device-id',
        'device-1',
        '--device-ip',
        '192.168.1.25',
        '--plan',
        '--apply'
      ])
    ).rejects.toThrow(/--plan or --apply/);
    expect(fetchMock).not.toHaveBeenCalled();
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
