import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCli } from '../src/cli/index';
import { MemorySecretStore } from '../src/secure/secret-store';
import { MemoryProfileStore } from './support/memory-profile-store';
import { buildDeepDive } from '../src/workflows/fleet-insights';

describe('cli integration', () => {
  it('allows read-only calls without --allow-write', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-device', 'device-key');

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const program = createCli({ profileStore, secretStore, stdout, stderr });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    await program.parseAsync([
      'node',
      'xyte-cli',
      'call',
      'device.registration.getChildDevices',
      '--tenant',
      'acme',
      '--path-json',
      '{"parent_id":"dev-1"}'
    ]);

    expect(stdout.write).toHaveBeenCalled();
  });

  it('passes query filters through call requests', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'call',
      'organization.spaces.getSpaces',
      '--tenant',
      'acme',
      '--query-json',
      '{"name":"Chicago Office","space_type":"customer"}'
    ]);

    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('name=Chicago+Office');
    expect(calledUrl).toContain('space_type=customer');
  });

  it('blocks write calls without --allow-write', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();

    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'call', 'organization.commands.sendCommand'])
    ).rejects.toThrow('--allow-write');
  });

  it('blocks organization update device call without --allow-write', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();

    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'call', 'organization.devices.updateDevice'])
    ).rejects.toThrow('--allow-write');
  });

  it('allows organization update device call without --confirm', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'call',
      'organization.devices.updateDevice',
      '--tenant',
      'acme',
      '--allow-write',
      '--path-json',
      '{"device_id":"dev-1"}',
      '--body-json',
      '{"nickname":"Lab Unit"}'
    ]);

    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('/core/v1/organization/devices/dev-1');
  });

  it('blocks device spaceMove call without --allow-write', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();

    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'call', 'device.device-info.spaceMove'])
    ).rejects.toThrow('--allow-write');
  });

  it('builds utility prepare for claim-device and scaffolds files', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const tmpRoot = mkdtempSync(join(tmpdir(), 'xyte-cli-utility-prepare-claim-'));
    const inputPath = join(tmpRoot, 'source.csv');
    const outputDir = join(tmpRoot, 'out');
    writeFileSync(inputPath, 'raw', 'utf8');

    await program.parseAsync([
      'node',
      'xyte-cli',
      'utility',
      'prepare',
      '--input',
      inputPath,
      '--action',
      'organization.devices.claimDevice',
      '--tenant',
      'acme',
      '--output-dir',
      outputDir
    ]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe('xyte.utility.prepare.v1');
    expect(parsed.actionKey).toBe('organization.devices.claimDevice');
    expect(parsed.mode).toBe('friendly');
    expect(parsed.suggestedCommands.next).toContain('claimDevice');
    expect(existsSync(join(outputDir, 'organization-devices-claimdevice.csv'))).toBe(true);
    expect(existsSync(join(outputDir, 'organization-devices-claimdevice.rejected.csv'))).toBe(true);
    expect(existsSync(join(outputDir, 'organization-devices-claimdevice.notes.md'))).toBe(true);
  });

  it('builds utility prepare for space.import-tree and scaffolds files', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const tmpRoot = mkdtempSync(join(tmpdir(), 'xyte-cli-utility-prepare-space-'));
    const inputPath = join(tmpRoot, 'source.pdf');
    const outputDir = join(tmpRoot, 'out');
    writeFileSync(inputPath, 'raw', 'utf8');

    await program.parseAsync([
      'node',
      'xyte-cli',
      'utility',
      'prepare',
      '--input',
      inputPath,
      '--action',
      'space.import-tree',
      '--tenant',
      'acme',
      '--output-dir',
      outputDir
    ]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe('xyte.utility.prepare.v1');
    expect(parsed.actionKey).toBe('space.import-tree');
    expect(parsed.mode).toBe('friendly');
    expect(existsSync(join(outputDir, 'space-import-tree.csv'))).toBe(true);
    expect(existsSync(join(outputDir, 'space-import-tree.rejected.csv'))).toBe(true);
    expect(existsSync(join(outputDir, 'space-import-tree.notes.md'))).toBe(true);
  });

  it('lists utility actions', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync(['node', 'xyte-cli', 'utility', 'list-actions', '--format', 'json']);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.some((item: any) => item.actionKey === 'organization.devices.claimDevice')).toBe(true);
    expect(parsed.some((item: any) => item.actionKey === 'space.import-tree')).toBe(true);
  });

  it('fails utility prepare when action is missing', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });
    const tmpRoot = mkdtempSync(join(tmpdir(), 'xyte-cli-utility-prepare-missing-'));
    const inputPath = join(tmpRoot, 'source.csv');
    writeFileSync(inputPath, 'raw', 'utf8');

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'utility', 'prepare', '--input', inputPath])
    ).rejects.toThrow();
  });

  it('runs space import-tree in dry-run mode', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const tmpRoot = mkdtempSync(join(tmpdir(), 'xyte-cli-space-import-dry-'));
    const inputPath = join(tmpRoot, 'space-import.csv');
    writeFileSync(inputPath, 'path,space_type\nHQ/Floor 1/Room 1,office\n', 'utf8');

    await program.parseAsync([
      'node',
      'xyte-cli',
      'space',
      'import-tree',
      '--tenant',
      'acme',
      '--input',
      inputPath
    ]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe('xyte.utility.batch.v1');
    expect(parsed.command).toBe('space.import-tree');
    expect(parsed.mode).toBe('dry-run');
  });

  it('does not expose device bulk-rename command', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(program.parseAsync(['node', 'xyte-cli', 'device', 'bulk-rename'])).rejects.toThrow(
      /unknown command|process\.exit unexpectedly called with "1"|too many arguments/
    );
  });

  it('does not expose mcp serve command', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(program.parseAsync(['node', 'xyte-cli', 'mcp', 'serve'])).rejects.toThrow(
      /unknown command|process\.exit unexpectedly called with "1"|too many arguments/
    );
  });

  it('shows one-line remediation when running bare xyte-cli without setup in non-interactive mode', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();

    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(program.parseAsync(['node', 'xyte-cli'])).rejects.toThrow(
      'Setup required. Run: xyte-cli setup run --non-interactive --tenant default --key "$XYTE_CLI_KEY".'
    );
  });

  it('launches dashboard directly when bare xyte-cli is already configured', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme', name: 'Acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'primary',
      fingerprint: 'sha256:test'
    });
    await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key');
    await profileStore.setActiveKeySlot('acme', 'xyte-org', slot.slotId);
    const runTui = vi.fn().mockResolvedValue(undefined);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'org-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    const program = createCli({
      profileStore,
      secretStore,
      runTui,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() }
    });

    await program.parseAsync(['node', 'xyte-cli']);
    expect(runTui).toHaveBeenCalledTimes(1);
    const args = runTui.mock.calls[0][0];
    expect(args.initialScreen).toBe('dashboard');
    expect(args.tenantId).toBe('acme');
  });

  it('requires --confirm for destructive calls', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();

    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'call', 'organization.commands.cancelCommand', '--allow-write'])
    ).rejects.toThrow('--confirm organization.commands.cancelCommand');
  });

  it('requires --confirm for organization close incident call', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();

    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'call', 'organization.incidents.closeIncident', '--allow-write'])
    ).rejects.toThrow('--confirm organization.incidents.closeIncident');
  });

  it('passes headless tui options through cli command', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const runTui = vi.fn().mockResolvedValue(undefined);

    const program = createCli({
      profileStore,
      secretStore,
      runTui,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() }
    });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'tui',
      '--headless',
      '--screen',
      'spaces',
      '--format',
      'json',
      '--once',
      '--tenant',
      'acme',
      '--no-motion',
      '--debug',
      '--debug-log',
      '/tmp/xyte-debug-test.log'
    ]);

    expect(runTui).toHaveBeenCalledTimes(1);
    const args = runTui.mock.calls[0][0];
    expect(args.headless).toBe(true);
    expect(args.initialScreen).toBe('spaces');
    expect(args.format).toBe('json');
    expect(args.follow).toBe(false);
    expect(args.motionEnabled).toBe(false);
    expect(args.tenantId).toBe('acme');
    expect(args.debug).toBe(true);
    expect(args.debugLogPath).toBe('/tmp/xyte-debug-test.log');
  });

  it('rejects non-json format in headless mode', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const runTui = vi.fn().mockResolvedValue(undefined);
    const program = createCli({
      profileStore,
      secretStore,
      runTui,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() }
    });

    await expect(program.parseAsync(['node', 'xyte-cli', 'tui', '--headless', '--format', 'text'])).rejects.toThrow(
      'Headless mode is JSON-only'
    );
    expect(runTui).not.toHaveBeenCalled();
  });

  it('does not force motion setting when --no-motion is omitted', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const runTui = vi.fn().mockResolvedValue(undefined);

    const program = createCli({
      profileStore,
      secretStore,
      runTui,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() }
    });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'tui',
      '--headless',
      '--screen',
      'dashboard',
      '--format',
      'json',
      '--once'
    ]);

    expect(runTui).toHaveBeenCalledTimes(1);
    const args = runTui.mock.calls[0][0];
    expect(args.headless).toBe(true);
    expect(args.motionEnabled).toBeUndefined();
  });

  it('prints setup status in json format', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const program = createCli({ profileStore, secretStore, stdout, stderr });
    await program.parseAsync(['node', 'xyte-cli', 'setup', 'status', '--format', 'json']);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.state).toBe('needs_setup');
  });

  it('prints status contract in fast mode', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync(['node', 'xyte-cli', 'status', '--mode', 'fast', '--format', 'json']);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe('xyte.status.v1');
    expect(parsed.mode).toBe('fast');
    expect(parsed.checkConnectivity).toBe(false);
    expect(parsed.readiness.connectionState).toBe('not_checked');
  });

  it('prints status contract in full mode with connectivity check', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'primary',
      fingerprint: 'sha256:test'
    });
    await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key');
    await profileStore.setActiveKeySlot('acme', 'xyte-org', slot.slotId);
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'org-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    await program.parseAsync(['node', 'xyte-cli', 'status', '--mode', 'full', '--format', 'json']);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe('xyte.status.v1');
    expect(parsed.mode).toBe('full');
    expect(parsed.checkConnectivity).toBe(true);
    expect(parsed.readiness.connectionState).toBe('connected');
  });

  it('supports named auth key lifecycle basics', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const program = createCli({ profileStore, secretStore, stdout, stderr });
    await program.parseAsync([
      'node',
      'xyte-cli',
      'auth',
      'key',
      'add',
      '--tenant',
      'acme',
      '--provider',
      'xyte-org',
      '--name',
      'primary',
      '--key',
      'org-key'
    ]);

    stdout.write.mockClear();
    await program.parseAsync([
      'node',
      'xyte-cli',
      'auth',
      'key',
      'list',
      '--tenant',
      'acme',
      '--provider',
      'xyte-org',
      '--format',
      'json'
    ]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.slots.length).toBe(1);
    expect(parsed.slots[0].hasSecret).toBe(true);
  });

  it('reports install diagnostics', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync(['node', 'xyte-cli', 'doctor', 'install', '--format', 'json']);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(['ok', 'missing', 'mismatch']).toContain(parsed.status);
    expect(parsed.expectedPath).toContain('dist/bin/xyte-cli.js');
  });

  it('emits call envelope when output-mode is envelope', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-device', 'device-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ result: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    await program.parseAsync([
      'node',
      'xyte-cli',
      'call',
      'device.registration.getChildDevices',
      '--tenant',
      'acme',
      '--path-json',
      '{"parent_id":"dev-1"}',
      '--output-mode',
      'envelope'
    ]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe('xyte.call.envelope.v1');
    expect(parsed.endpointKey).toBe('device.registration.getChildDevices');
    expect(parsed.response.status).toBe(200);
  });

  it('runs inspect fleet with deterministic json output', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/devices')) {
          return new Response(JSON.stringify({ items: [{ id: 'd1', status: 'offline' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/spaces')) {
          return new Response(JSON.stringify({ items: [{ id: 's1', name: 'Room A', space_type: 'room' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/incidents')) {
          return new Response(JSON.stringify({ items: [{ id: 'i1', status: 'active', created_at: new Date().toISOString() }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/tickets')) {
          return new Response(JSON.stringify({ items: [{ id: 't1', status: 'open', created_at: new Date().toISOString() }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );

    await program.parseAsync(['node', 'xyte-cli', 'inspect', 'fleet', '--tenant', 'acme', '--format', 'json']);
    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe('xyte.inspect.fleet.v1');
    expect(parsed.tenantId).toBe('acme');
  });

  it('generates markdown report from deep-dive input', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const tmpRoot = mkdtempSync(join(tmpdir(), 'xyte-report-test-'));
    const inputPath = join(tmpRoot, 'deep-dive.json');
    const outPath = join(tmpRoot, 'report.md');

    const deepDive = buildDeepDive({
      generatedAtUtc: new Date().toISOString(),
      tenantId: 'acme',
      devices: [{ id: 'd1', name: 'Device 1', status: 'offline', space: { full_path: 'Overview/A' } }],
      spaces: [{ id: 's1', name: 'Room A', space_type: 'room' }],
      incidents: [{ id: 'i1', device_name: 'Device 1', status: 'active', space_tree_path_name: 'Overview/A', created_at: new Date().toISOString() }],
      tickets: [{ id: 't1', title: 'Need help', status: 'open', created_at: new Date().toISOString(), device_id: 'd1' }]
    });
    writeFileSync(inputPath, JSON.stringify(deepDive, null, 2), 'utf8');

    await program.parseAsync([
      'node',
      'xyte-cli',
      'report',
      'generate',
      '--tenant',
      'acme',
      '--input',
      inputPath,
      '--out',
      outPath,
      '--format',
      'markdown'
    ]);

    const reportText = readFileSync(outPath, 'utf8');
    expect(reportText).toContain('# Xyte Fleet Deep Dive');
    expect(reportText).toContain('## Summary');
  });

  it('defaults report generation to branded pdf output', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const tmpRoot = mkdtempSync(join(tmpdir(), 'xyte-report-pdf-test-'));
    const inputPath = join(tmpRoot, 'deep-dive.json');
    const outPath = join(tmpRoot, 'report.pdf');

    const deepDive = buildDeepDive({
      generatedAtUtc: new Date().toISOString(),
      tenantId: 'acme',
      devices: [{ id: 'd1', name: 'Device 1', status: 'offline', space: { full_path: 'Overview/A' } }],
      spaces: [{ id: 's1', name: 'Room A', space_type: 'room' }],
      incidents: [{ id: 'i1', device_name: 'Device 1', status: 'active', space_tree_path_name: 'Overview/A', created_at: new Date().toISOString() }],
      tickets: [{ id: 't1', title: 'Need help', status: 'open', created_at: new Date().toISOString(), device_id: 'd1' }]
    });
    writeFileSync(inputPath, JSON.stringify(deepDive, null, 2), 'utf8');

    await program.parseAsync([
      'node',
      'xyte-cli',
      'report',
      'generate',
      '--tenant',
      'acme',
      '--input',
      inputPath,
      '--out',
      outPath
    ]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.format).toBe('pdf');
    expect(parsed.includeSensitive).toBe(false);

    const reportBytes = readFileSync(outPath);
    expect(reportBytes.subarray(0, 4).toString()).toBe('%PDF');
    expect(reportBytes.byteLength).toBeGreaterThan(500);
  });

  it('runs simplified setup in non-interactive mode with only tenant+key', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'org-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    await program.parseAsync([
      'node',
      'xyte-cli',
      'setup',
      'run',
      '--non-interactive',
      '--tenant',
      'playground',
      '--key',
      'org-key'
    ]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.provider).toBe('xyte-org');
    expect(parsed.slot.name.toLowerCase()).toBe('primary');
    expect(parsed.readiness.state).toBe('ready');
  });

  it('runs setup with connectivity mode never and marks connectivity step as skipped', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'setup',
      'run',
      '--non-interactive',
      '--tenant',
      'playground',
      '--key',
      'org-key',
      '--connectivity',
      'never'
    ]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.connectivityMode).toBe('never');
    const step = parsed.steps.find((item: any) => item.key === 'connectivity_checked');
    expect(step.status).toBe('skipped');
    expect(parsed.readiness.connectionState).toBe('not_checked');
  });

  it('runs setup with connectivity mode always and marks connectivity step as ok', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'org-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    await program.parseAsync([
      'node',
      'xyte-cli',
      'setup',
      'run',
      '--non-interactive',
      '--tenant',
      'playground',
      '--key',
      'org-key',
      '--connectivity',
      'always'
    ]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.connectivityMode).toBe('always');
    const step = parsed.steps.find((item: any) => item.key === 'connectivity_checked');
    expect(step.status).toBe('ok');
    expect(parsed.readiness.connectionState).toBe('connected');
  });

  it('installs skill to target workspace with --no-setup', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const target = mkdtempSync(join(tmpdir(), 'xyte-cli-skill-install-'));

    await program.parseAsync(['node', 'xyte-cli', 'install', '--skills', '--target', target, '--no-setup']);

    expect(existsSync(join(target, '.claude', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, '.github', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, '.agents', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Workspace target');
    expect(output).toContain('Skill install summary');
  });

  it('runs install --skills with setup when XYTE_CLI_KEY is present', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const target = mkdtempSync(join(tmpdir(), 'xyte-cli-install-setup-'));
    const previousEnv = process.env.XYTE_CLI_KEY;
    process.env.XYTE_CLI_KEY = 'org-key';

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'org-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    try {
      await program.parseAsync(['node', 'xyte-cli', 'install', '--skills', '--target', target]);
    } finally {
      if (previousEnv === undefined) {
        delete process.env.XYTE_CLI_KEY;
      } else {
        process.env.XYTE_CLI_KEY = previousEnv;
      }
    }

    expect(existsSync(join(target, '.claude', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, '.github', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, '.agents', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Setup complete');
  });

  it('installs only codex skill in user scope when requested', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const target = mkdtempSync(join(tmpdir(), 'xyte-cli-install-user-target-'));
    const fakeHome = mkdtempSync(join(tmpdir(), 'xyte-cli-install-user-home-'));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;

    try {
      await program.parseAsync([
        'node',
        'xyte-cli',
        'install',
        '--skills',
        '--target',
        target,
        '--scope',
        'user',
        '--agents',
        'codex',
        '--no-setup'
      ]);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousUserProfile === undefined) {
        delete process.env.USERPROFILE;
      } else {
        process.env.USERPROFILE = previousUserProfile;
      }
    }

    expect(existsSync(join(fakeHome, '.agents', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(fakeHome, '.claude', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(false);
    expect(existsSync(join(target, '.claude', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(false);
  });

  it('prompts for scope and agents in interactive mode when flags are omitted', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const promptValue = vi
      .fn()
      .mockResolvedValueOnce('project')
      .mockResolvedValueOnce('claude,codex');
    const program = createCli({
      profileStore,
      secretStore,
      stdout,
      stderr,
      isTTY: true,
      promptValue
    });
    const target = mkdtempSync(join(tmpdir(), 'xyte-cli-install-interactive-'));

    await program.parseAsync(['node', 'xyte-cli', 'install', '--skills', '--target', target, '--no-setup']);

    expect(promptValue).toHaveBeenCalledTimes(2);
    expect(existsSync(join(target, '.claude', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, '.agents', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, '.github', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(false);
  });

  it('returns a clear error for invalid --agents value', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'install',
        '--skills',
        '--scope',
        'project',
        '--agents',
        'claude,unknown',
        '--no-setup'
      ])
    ).rejects.toThrow('Invalid agents');
  });

  it('skips existing skill without --force and overwrites with --force', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const target = mkdtempSync(join(tmpdir(), 'xyte-cli-install-force-'));

    await program.parseAsync([
      'node',
      'xyte-cli',
      'install',
      '--skills',
      '--target',
      target,
      '--scope',
      'project',
      '--agents',
      'claude',
      '--no-setup'
    ]);

    stdout.write.mockClear();
    await program.parseAsync([
      'node',
      'xyte-cli',
      'install',
      '--skills',
      '--target',
      target,
      '--scope',
      'project',
      '--agents',
      'claude',
      '--no-setup'
    ]);
    const skippedOutput = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(skippedOutput).toContain('skipped');

    stdout.write.mockClear();
    await program.parseAsync([
      'node',
      'xyte-cli',
      'install',
      '--skills',
      '--target',
      target,
      '--scope',
      'project',
      '--agents',
      'claude',
      '--force',
      '--no-setup'
    ]);
    const overwrittenOutput = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(overwrittenOutput).toContain('overwritten');
  });

  it('fails install when any target destination fails', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const target = mkdtempSync(join(tmpdir(), 'xyte-cli-install-partial-fail-'));
    writeFileSync(join(target, '.github'), 'not-a-directory', 'utf8');

    await expect(program.parseAsync(['node', 'xyte-cli', 'install', '--skills', '--target', target, '--no-setup'])).rejects.toThrow(
      'Skill installation failed'
    );

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('project/copilot: failed');
  });

  it('does not register removed auth wrapper commands', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const authCommand = program.commands.find((command) => command.name() === 'auth');
    expect(authCommand).toBeDefined();
    expect(authCommand?.commands.map((command) => command.name())).not.toContain('set-key');
    expect(authCommand?.commands.map((command) => command.name())).not.toContain('clear-key');
  });

  it('checks for upgrade without mutating', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const commandRunner = vi.fn();
    const program = createCli({
      profileStore,
      secretStore,
      stdout,
      stderr,
      upgradeDependencies: {
        fetchImpl: vi.fn().mockImplementation(async () =>
          new Response(JSON.stringify({ version: '0.5.0' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        ),
        commandRunner,
        getCurrentVersion: () => '0.4.0'
      }
    });

    await program.parseAsync(['node', 'xyte-cli', 'upgrade', '--check', '--format', 'json']);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe('xyte.upgrade.check.v1');
    expect(parsed.currentVersion).toBe('0.4.0');
    expect(parsed.latestVersion).toBe('0.5.0');
    expect(commandRunner).not.toHaveBeenCalled();
  });

  it('warns and succeeds when upgrade skill refresh partially fails', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const commandRunner = vi.fn(async (command: string) => {
      if (command === 'xyte-cli') {
        return {
          code: 0,
          stdout: 'xyte-cli 0.5.0\n',
          stderr: ''
        };
      }
      return {
        code: 0,
        stdout: '',
        stderr: ''
      };
    });
    const installSkillsImpl = vi.fn().mockResolvedValue({
      workspaceRoot: '/tmp/workspace',
      homeRoot: '/tmp/home',
      sourceDir: '/tmp/skills/xyte-cli',
      outcomes: [
        {
          scope: 'user',
          agent: 'claude',
          rootDir: '/tmp/home/.claude/skills',
          targetDir: '/tmp/home/.claude/skills/xyte-cli',
          status: 'installed'
        },
        {
          scope: 'user',
          agent: 'copilot',
          rootDir: '/tmp/home/.copilot/skills',
          targetDir: '/tmp/home/.copilot/skills/xyte-cli',
          status: 'failed',
          error: 'permission denied'
        }
      ],
      createdRoots: []
    });

    const program = createCli({
      profileStore,
      secretStore,
      stdout,
      stderr,
      upgradeDependencies: {
        fetchImpl: vi.fn().mockImplementation(async () =>
          new Response(JSON.stringify({ version: '0.5.0' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        ),
        commandRunner,
        installSkillsImpl,
        getCurrentVersion: () => '0.4.0'
      }
    });

    await program.parseAsync(['node', 'xyte-cli', 'upgrade', '--yes', '--format', 'json']);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe('xyte.upgrade.result.v1');
    expect(parsed.updated).toBe(true);
    expect(parsed.skills.scope).toBe('user');
    expect(parsed.skills.failedCount).toBe(1);
    expect(parsed.warnings.length).toBeGreaterThan(0);
  });

  it('uses controlled upgrade spec from environment when provided', async () => {
    const previousSpec = process.env.XYTE_CLI_UPGRADE_SPEC;
    const previousTarget = process.env.XYTE_CLI_UPGRADE_TARGET_VERSION;
    process.env.XYTE_CLI_UPGRADE_SPEC = '/artifacts/xyteai-cli-b.tgz';
    process.env.XYTE_CLI_UPGRADE_TARGET_VERSION = '0.5.0';

    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const fetchImpl = vi.fn();
    const commandRunner = vi.fn(async (command: string, args: string[]) => {
      if (command === 'npm') {
        expect(args).toEqual(['install', '--global', '/artifacts/xyteai-cli-b.tgz']);
        return {
          code: 0,
          stdout: '',
          stderr: ''
        };
      }
      return {
        code: 0,
        stdout: 'xyte-cli 0.5.0\n',
        stderr: ''
      };
    });
    const installSkillsImpl = vi.fn().mockResolvedValue({
      workspaceRoot: '/tmp/workspace',
      homeRoot: '/tmp/home',
      sourceDir: '/tmp/skills/xyte-cli',
      outcomes: [],
      createdRoots: []
    });

    const program = createCli({
      profileStore,
      secretStore,
      stdout,
      stderr,
      upgradeDependencies: {
        fetchImpl: fetchImpl as any,
        commandRunner,
        installSkillsImpl,
        getCurrentVersion: () => '0.4.0'
      }
    });

    try {
      await program.parseAsync(['node', 'xyte-cli', 'upgrade', '--yes', '--format', 'json']);
    } finally {
      if (previousSpec === undefined) {
        delete process.env.XYTE_CLI_UPGRADE_SPEC;
      } else {
        process.env.XYTE_CLI_UPGRADE_SPEC = previousSpec;
      }
      if (previousTarget === undefined) {
        delete process.env.XYTE_CLI_UPGRADE_TARGET_VERSION;
      } else {
        process.env.XYTE_CLI_UPGRADE_TARGET_VERSION = previousTarget;
      }
    }

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
