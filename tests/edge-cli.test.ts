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
        'ping',
        '--tenant',
        'acme',
        '--proxy-id',
        'proxy-1',
        '--device-ip',
        '192.168.1.10',
        '--apply',
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
    expect(url).toContain('/core/v1/organization/devices/edge/claim');
    expect(url).toContain('proxy_id=proxy-1');
    expect(url).toContain('device_ip=192.168.1.10');

    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('xyte.edge.claim-status.v1');
    expect(printed).toContain('"result": "pending"');
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
    expect(url).toContain('/core/v1/organization/devices/edge/ping');
    expect(url).toContain('proxy_id=proxy-1');
    expect(url).toContain('device_ip=192.168.1.10');

    const printed = stdout.write.mock.calls.map(([chunk]) => chunk).join('');
    expect(printed).toContain('xyte.edge.ping-status.v1');
  });
});
