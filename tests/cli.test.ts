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
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');

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
      'api',
      'call',
      'organization.getOrganizationInfo',
      '--tenant',
      'acme'
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
      'api',
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

  it('rejects removed device endpoint metadata lookups', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'api', 'endpoints', 'describe', 'device.registration.getChildDevices'])
    ).rejects.toThrow('Unknown endpoint key');
  });

  it('allows write calls without the legacy write flag', async () => {
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
      'api',
      'call',
      'organization.commands.sendCommand',
      '--tenant',
      'acme',
      '--path-json',
      '{"device_id":"dev-1"}',
      '--body-json',
      '{"command":"reboot"}'
    ]);

    expect(fetchMock).toHaveBeenCalled();
  });

  it('allows organization update device call without the legacy write flag', async () => {
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
      'api',
      'call',
      'organization.devices.updateDevice',
      '--tenant',
      'acme',
      '--path-json',
      '{"device_id":"dev-1"}',
      '--body-json',
      '{"nickname":"Lab Unit"}'
    ]);

    expect(fetchMock).toHaveBeenCalled();
  });

  it('allows organization update device call without legacy write flags', async () => {
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
      'api',
      'call',
      'organization.devices.updateDevice',
      '--tenant',
      'acme',
      '--path-json',
      '{"device_id":"dev-1"}',
      '--body-json',
      '{"nickname":"Lab Unit"}'
    ]);

    expect(fetchMock).toHaveBeenCalled();
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toContain('/core/v1/organization/devices/dev-1');
  });

  it('allows partner close ticket call without the legacy write flag', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-partner', 'partner-key');
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
      'api',
      'call',
      'partner.tickets.closeTicket',
      '--tenant',
      'acme',
      '--path-json',
      '{"ticket_id":"tic-1"}'
    ]);

    expect(fetchMock).toHaveBeenCalled();
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
      'util',
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
    expect(parsed.suggestedCommands.next).toContain('Preflight gate');
    expect(parsed.suggestedCommands.apply).toContain('organization.devices.claimDevice');
    expect(parsed.suggestedCommands.apply).toContain('--body-json');
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
      'util',
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

    await program.parseAsync(['node', 'xyte-cli', 'util', 'list-actions', '--format', 'json']);

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

    await expect(program.parseAsync(['node', 'xyte-cli', 'util', 'prepare', '--input', inputPath])).rejects.toThrow();
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

    await program.parseAsync(['node', 'xyte-cli', 'util', 'import-tree', '--tenant', 'acme', '--input', inputPath]);

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

  it('prints root launcher JSON when bare xyte-cli is not configured in non-interactive mode', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };

    const program = createCli({ profileStore, secretStore, stdout, stderr: { write: vi.fn() } });

    await program.parseAsync(['node', 'xyte-cli']);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe('xyte.root.launcher.v1');
    expect(parsed.configured).toBe(false);
    expect(parsed.sections.map((section: any) => section.title)).toEqual([
      'Setup',
      'Everyday Ops',
      'Raw API',
      'Config & Credentials',
      'Console / Headless',
      'Examples'
    ]);
    expect(parsed.sections[0].commands[0]).toBe('xyte-cli setup run --tenant default');
  });

  it('prints launcher text on TTY when bare xyte-cli is not configured', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn(), isTTY: true };
    const runTui = vi.fn().mockResolvedValue(undefined);

    const program = createCli({
      profileStore,
      secretStore,
      runTui,
      stdout,
      stderr: { write: vi.fn() },
      stdoutIsTTY: true
    });

    await program.parseAsync(['node', 'xyte-cli']);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('xyte-cli');
    expect(output).toContain('Readiness: needs_setup');
    expect(output).toContain('Setup');
    expect(output).toContain('xyte-cli ops console --screen setup');
    expect(runTui).not.toHaveBeenCalled();
  });

  it('prints launcher text on TTY when bare xyte-cli is already configured', async () => {
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
    const stdout = { write: vi.fn(), isTTY: true };

    const program = createCli({
      profileStore,
      secretStore,
      runTui,
      stdout,
      stderr: { write: vi.fn() },
      stdoutIsTTY: true
    });

    await program.parseAsync(['node', 'xyte-cli']);
    expect(runTui).not.toHaveBeenCalled();
    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Readiness: ready');
    expect(output).toContain('Everyday Ops');
    expect(output).toContain('xyte-cli ops watch incidents --tenant acme --once --output json --strict-json');
    expect(output).toContain('xyte-cli ops console --screen dashboard');
  });

  it('allows destructive calls without legacy confirm flags', async () => {
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
      'api',
      'call',
      'organization.commands.cancelCommand',
      '--tenant',
      'acme',
      '--path-json',
      '{"device_id":"dev-1","command_id":"cmd-1"}'
    ]);

    expect(fetchMock).toHaveBeenCalled();
  });

  it('allows close incident call without legacy confirm flags', async () => {
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
      'api',
      'call',
      'organization.incidents.closeIncident',
      '--tenant',
      'acme',
      '--path-json',
      '{"incident_id":"inc-1"}'
    ]);

    expect(fetchMock).toHaveBeenCalled();
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
      'ops',
      'console',
      '--headless',
      '--screen',
      'spaces',
      '--output',
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

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'ops', 'console', '--headless', '--output', 'text'])
    ).rejects.toThrow('Headless mode is JSON-only');
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
      'ops',
      'console',
      '--headless',
      '--screen',
      'dashboard',
      '--output',
      'json',
      '--once'
    ]);

    expect(runTui).toHaveBeenCalledTimes(1);
    const args = runTui.mock.calls[0][0];
    expect(args.headless).toBe(true);
    expect(args.motionEnabled).toBe(true);
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

  it('prints setup status scalar fields directly', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const program = createCli({ profileStore, secretStore, stdout, stderr });
    await program.parseAsync(['node', 'xyte-cli', 'setup', 'status', '--tenant', 'acme', '--field', 'tenantId']);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toBe('acme\n');
  });

  it('manages user and workspace settings through config commands', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const cwd = mkdtempSync(join(tmpdir(), 'xyte-cli-config-workspace-'));
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-cli-config-user-'));
    const env = { ...process.env, XYTE_CLI_CONFIG_DIR: configDir };
    const program = createCli({ profileStore, secretStore, stdout, stderr, cwd, env });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'config',
      'set',
      'output.mode',
      'text',
      '--scope',
      'user',
      '--output',
      'json'
    ]);

    stdout.write.mockClear();
    await program.parseAsync([
      'node',
      'xyte-cli',
      'config',
      'set',
      'console.screen',
      'spaces',
      '--scope',
      'workspace',
      '--output',
      'json'
    ]);

    stdout.write.mockClear();
    await program.parseAsync(['node', 'xyte-cli', 'config', 'show', '--scope', 'resolved', '--output', 'json']);
    let output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    let parsed = JSON.parse(output);
    expect(parsed.values.output.mode).toBe('text');
    expect(parsed.values.console.screen).toBe('spaces');
    expect(parsed.sources['output.mode']).toBe('user');
    expect(parsed.sources['console.screen']).toBe('workspace');

    stdout.write.mockClear();
    await program.parseAsync(['node', 'xyte-cli', 'config', 'path', '--output', 'json']);
    output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    parsed = JSON.parse(output);
    expect(parsed.configDir).toBe(configDir);
    expect(parsed.user).toBe(join(configDir, 'settings.json'));
    expect(parsed.workspace).toBe(join(cwd, '.xyte', 'config.json'));

    stdout.write.mockClear();
    await program.parseAsync([
      'node',
      'xyte-cli',
      'config',
      'unset',
      'console.screen',
      '--scope',
      'workspace',
      '--output',
      'json'
    ]);

    stdout.write.mockClear();
    await program.parseAsync(['node', 'xyte-cli', 'config', 'show', '--scope', 'resolved', '--output', 'json']);
    output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    parsed = JSON.parse(output);
    expect(parsed.values.console.screen).toBe('dashboard');
    expect(parsed.sources['console.screen']).toBe('default');
  });

  it('lets env defaults win over config until explicit flags override them', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'user-tenant' });
    await profileStore.upsertTenant({ id: 'workspace-tenant' });
    await profileStore.upsertTenant({ id: 'env-tenant' });
    await profileStore.upsertTenant({ id: 'cli-tenant' });
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const cwd = mkdtempSync(join(tmpdir(), 'xyte-cli-config-precedence-workspace-'));
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-cli-config-precedence-user-'));
    const env = {
      ...process.env,
      XYTE_CLI_CONFIG_DIR: configDir,
      XYTE_CLI_DEFAULT_TENANT: 'env-tenant'
    };
    const program = createCli({ profileStore, secretStore, stdout, stderr, cwd, env });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'config',
      'set',
      'defaults.tenant',
      'user-tenant',
      '--scope',
      'user',
      '--output',
      'json'
    ]);
    stdout.write.mockClear();

    await program.parseAsync([
      'node',
      'xyte-cli',
      'config',
      'set',
      'defaults.tenant',
      'workspace-tenant',
      '--scope',
      'workspace',
      '--output',
      'json'
    ]);
    stdout.write.mockClear();

    await program.parseAsync(['node', 'xyte-cli', 'status', '--mode', 'fast', '--output', 'json']);
    let output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    let parsed = JSON.parse(output);
    expect(parsed.readiness.tenantId).toBe('env-tenant');

    stdout.write.mockClear();
    await program.parseAsync([
      'node',
      'xyte-cli',
      'status',
      '--mode',
      'fast',
      '--tenant',
      'cli-tenant',
      '--output',
      'json'
    ]);
    output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    parsed = JSON.parse(output);
    expect(parsed.readiness.tenantId).toBe('cli-tenant');
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
      'config',
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
      'config',
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

  it('adds key slots from stdin without exposing the key on argv', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const program = createCli({
      profileStore,
      secretStore,
      stdout,
      stderr,
      readStdinValue: vi.fn().mockResolvedValue('org-key')
    });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'config',
      'key',
      'add',
      '--tenant',
      'acme',
      '--provider',
      'xyte-org',
      '--name',
      'primary',
      '--key-stdin'
    ]);

    const [slot] = await profileStore.listKeySlots('acme', 'xyte-org');
    const stored = await secretStore.getSlotSecret('acme', 'xyte-org', slot!.slotId);
    expect(stored).toBe('org-key');
  });

  it('updates key slots from stdin without exposing the key on argv', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    const secretStore = new MemorySecretStore();
    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'primary',
      fingerprint: 'sha256:old'
    });
    await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'old-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const program = createCli({
      profileStore,
      secretStore,
      stdout,
      stderr,
      readStdinValue: vi.fn().mockResolvedValue('new-key')
    });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'config',
      'key',
      'update',
      '--tenant',
      'acme',
      '--provider',
      'xyte-org',
      '--slot',
      slot.slotId,
      '--key-stdin'
    ]);

    const stored = await secretStore.getSlotSecret('acme', 'xyte-org', slot.slotId);
    expect(stored).toBe('new-key');
  });

  it('prefers stdin over XYTE_CLI_KEY during key update', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    const secretStore = new MemorySecretStore();
    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'primary',
      fingerprint: 'sha256:old'
    });
    const program = createCli({
      profileStore,
      secretStore,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      env: {
        ...process.env,
        XYTE_CLI_KEY: 'env-key'
      },
      readStdinValue: vi.fn().mockResolvedValue('stdin-key')
    });

    await program.parseAsync([
      'node',
      'xyte-cli',
      'config',
      'key',
      'update',
      '--tenant',
      'acme',
      '--provider',
      'xyte-org',
      '--slot',
      slot.slotId,
      '--key-stdin'
    ]);

    const stored = await secretStore.getSlotSecret('acme', 'xyte-org', slot.slotId);
    expect(stored).toBe('stdin-key');
  });

  it('rejects unsupported auth provider', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'config',
        'key',
        'add',
        '--tenant',
        'acme',
        '--provider',
        'xyte-device',
        '--name',
        'legacy',
        '--key',
        'legacy-key'
      ])
    ).rejects.toThrow('Invalid provider: xyte-device');
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
    expect(String(parsed.expectedPath).replaceAll('\\', '/')).toContain('dist/bin/xyte-cli.js');
  });

  it('emits call envelope when output-mode is envelope', async () => {
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
      'api',
      'call',
      'organization.devices.getDevices',
      '--tenant',
      'acme',
      '--output-mode',
      'envelope'
    ]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe('xyte.call.envelope.v1');
    expect(parsed.endpointKey).toBe('organization.devices.getDevices');
    expect(parsed.response.status).toBe(200);
  });

  it('emits one snapshot frame for watch --once', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'inc-1', status: 'active' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'inc-1', status: 'active' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync(['node', 'xyte-cli', 'ops', 'watch', 'incidents', '--tenant', 'acme', '--once']);

    const lines = stdout.write.mock.calls.map((call) => String(call[0]).trim()).filter(Boolean);
    expect(lines).toHaveLength(1);
    const frame = JSON.parse(lines[0]);
    expect(frame.schemaVersion).toBe('xyte.watch.frame.v1');
    expect(frame.eventType).toBe('snapshot');
    expect(frame.summary.total).toBe(1);
    expect(Array.isArray(frame.items)).toBe(true);
    expect(frame.items[0].id).toBe('inc-1');
  });

  it('tees watch output to --out as ndjson', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const outPath = join(mkdtempSync(join(tmpdir(), 'xyte-watch-out-')), 'artifacts', 'incidents.ndjson');

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'inc-1', status: 'active' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'inc-1', status: 'active' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'ops',
      'watch',
      'incidents',
      '--tenant',
      'acme',
      '--once',
      '--out',
      outPath
    ]);

    const stdoutOutput = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(readFileSync(outPath, 'utf8')).toBe(stdoutOutput);
    const frame = JSON.parse(stdoutOutput.trim());
    expect(frame.schemaVersion).toBe('xyte.watch.frame.v1');
  });

  it('renders watch frames as text on tty by default', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr, stdoutIsTTY: true });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'inc-1',
                status: 'active',
                priority: 'high',
                title: 'Device offline',
                device_name: 'Device One',
                space_tree_path_name: 'Overview/Lab'
              }
            ]
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
      )
    );

    await program.parseAsync(['node', 'xyte-cli', 'ops', 'watch', 'incidents', '--tenant', 'acme', '--once']);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('[snapshot] poll 1 | 1 active incidents');
    expect(output).toContain('[HIGH] Device offline | Device One | Overview/Lab');
  });

  it('emits snapshot then heartbeat for unchanged watch polls', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'inc-1', status: 'active' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'inc-1', status: 'active' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'ops',
      'watch',
      'incidents',
      '--tenant',
      'acme',
      '--interval-ms',
      '1000',
      '--max-polls',
      '2'
    ]);

    const frames = stdout.write.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(frames).toHaveLength(2);
    expect(frames[0].eventType).toBe('snapshot');
    expect(frames[1].eventType).toBe('heartbeat');
    expect(frames[1].summary.changed).toBe(false);
  });

  it('emits snapshot then delta for changed watch polls', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'inc-1', status: 'active' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            items: [
              { id: 'inc-1', status: 'resolved' },
              { id: 'inc-2', status: 'active' }
            ]
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        )
      );
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'ops',
      'watch',
      'incidents',
      '--tenant',
      'acme',
      '--interval-ms',
      '1000',
      '--max-polls',
      '2'
    ]);

    const frames = stdout.write.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(frames).toHaveLength(2);
    expect(frames[0].eventType).toBe('snapshot');
    expect(frames[1].eventType).toBe('delta');
    expect(frames[1].summary.added).toBe(1);
    expect(frames[1].summary.updated).toBe(1);
    expect(frames[1].delta.added[0].id).toBe('inc-2');
    expect(frames[1].delta.updated[0].id).toBe('inc-1');
  });

  it('emits error frame and preserves baseline on transient watch poll failures', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'inc-1', status: 'active' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'upstream unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'upstream unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'upstream unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ id: 'inc-1', status: 'active' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'ops',
      'watch',
      'incidents',
      '--tenant',
      'acme',
      '--interval-ms',
      '1000',
      '--max-polls',
      '3'
    ]);

    const frames = stdout.write.mock.calls.map((call) => JSON.parse(String(call[0])));
    expect(frames).toHaveLength(3);
    expect(frames[0].eventType).toBe('snapshot');
    expect(frames[1].eventType).toBe('error');
    expect(frames[2].eventType).toBe('heartbeat');
    expect(frames[2].summary.total).toBe(1);
    expect(frames[2].summary.changed).toBe(false);
  });

  it('rejects invalid watch profile', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'ops', 'watch', 'incidents', '--profile', 'devices', '--once'])
    ).rejects.toThrow('Invalid watch profile');
  });

  it('rejects watch interval below 1000ms', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'ops', 'watch', 'incidents', '--interval-ms', '100', '--once'])
    ).rejects.toThrow('Minimum is 1000ms');
  });

  it('rejects watch max-polls above hard cap', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'ops', 'watch', 'incidents', '--max-polls', '3601', '--once'])
    ).rejects.toThrow('Maximum is 3600');
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
          return new Response(
            JSON.stringify({ items: [{ id: 'i1', status: 'active', created_at: new Date().toISOString() }] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' }
            }
          );
        }
        if (url.includes('/tickets')) {
          return new Response(
            JSON.stringify({ items: [{ id: 't1', status: 'open', created_at: new Date().toISOString() }] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' }
            }
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );

    await program.parseAsync(['node', 'xyte-cli', 'ops', 'inspect', 'fleet', '--tenant', 'acme', '--render', 'json']);
    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe('xyte.inspect.fleet.v1');
    expect(parsed.tenantId).toBe('acme');
  });

  it('tees inspect fleet output to --out', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const outPath = join(mkdtempSync(join(tmpdir(), 'xyte-fleet-out-')), 'artifacts', 'fleet.json');

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
          return new Response(
            JSON.stringify({ items: [{ id: 'i1', status: 'active', created_at: new Date().toISOString() }] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' }
            }
          );
        }
        if (url.includes('/tickets')) {
          return new Response(
            JSON.stringify({ items: [{ id: 't1', status: 'open', created_at: new Date().toISOString() }] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' }
            }
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      })
    );

    await program.parseAsync([
      'node',
      'xyte-cli',
      'ops',
      'inspect',
      'fleet',
      '--tenant',
      'acme',
      '--render',
      'json',
      '--out',
      outPath
    ]);

    const stdoutOutput = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(readFileSync(outPath, 'utf8')).toBe(stdoutOutput);
    const parsed = JSON.parse(stdoutOutput);
    expect(parsed.schemaVersion).toBe('xyte.inspect.fleet.v1');
  });

  it('runs inspect fleet in partner-only auto scope without organization calls', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const partnerSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-partner',
      name: 'partner-primary',
      fingerprint: 'sha256:partner'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-partner', partnerSlot.slotId);
    await secretStore.setSlotSecret('acme', 'xyte-partner', partnerSlot.slotId, 'partner-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/partner/devices')) {
        return new Response(JSON.stringify({ items: [{ id: 'pd1', status: 'offline' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/tickets')) {
        return new Response(
          JSON.stringify({ items: [{ id: 'pt1', status: 'open', created_at: new Date().toISOString() }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'ops',
      'inspect',
      'fleet',
      '--tenant',
      'acme',
      '--provider-scope',
      'auto',
      '--render',
      'json'
    ]);

    const parsed = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    expect(parsed.schemaVersion).toBe('xyte.inspect.fleet.v1');
    expect(parsed.totals.devices).toBe(1);
    expect(parsed.totals.spaces).toBe(0);
    expect(parsed.totals.incidents).toBe(0);
    expect(parsed.totals.tickets).toBe(1);
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.every((url) => url.includes('/partner/'))).toBe(true);
    expect(calledUrls.some((url) => url.includes('/organization/'))).toBe(false);
    expect(calledUrls.some((url) => url.includes('/partner/devices/histories'))).toBe(false);
  });

  it('runs inspect deep-dive in partner-only auto scope without organization calls', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-partner', 'partner-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/partner/devices/') && url.includes('/commands')) {
        return new Response(JSON.stringify({ commands: [{ id: 'c1', status: 'sent' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/devices/') && url.includes('/telemetries')) {
        return new Response(JSON.stringify({ telemetries: [{ id: 'tm1', timestamp: new Date().toISOString() }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/devices/') && url.includes('/history')) {
        return new Response(JSON.stringify({ history: [{ id: 'h1', status: 'online' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/devices/')) {
        return new Response(
          JSON.stringify({
            device: { id: 'pd1', model: 'Model-X', firmware_version: '1.0.0', last_seen_at: new Date().toISOString() }
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      if (url.includes('/partner/devices')) {
        return new Response(JSON.stringify({ items: [{ id: 'pd1', status: 'offline', name: 'Partner Device' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/tickets')) {
        return new Response(
          JSON.stringify({
            items: [{ id: 'pt1', status: 'open', title: 'Partner ticket', created_at: new Date().toISOString() }]
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'ops',
      'inspect',
      'deep-dive',
      '--tenant',
      'acme',
      '--provider-scope',
      'auto',
      '--window',
      '24',
      '--render',
      'json'
    ]);

    const parsed = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    expect(parsed.schemaVersion).toBe('xyte.inspect.deep-dive.v1');
    expect(parsed.tenantId).toBe('acme');
    expect(parsed.ticketPosture.openTickets).toBe(1);
    expect(parsed.churnWindow.incidents).toBe(0);
    expect(parsed.summary.some((line: string) => line.startsWith('Partner model distribution:'))).toBe(true);
    expect(parsed.summary.some((line: string) => line.startsWith('Partner telemetry coverage:'))).toBe(true);
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.every((url) => url.includes('/partner/'))).toBe(true);
    expect(calledUrls.some((url) => url.includes('/organization/'))).toBe(false);
    expect(calledUrls.some((url) => url.includes('/partner/devices/histories'))).toBe(false);
  });

  it('tees deep-dive markdown output to --out', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-partner', 'partner-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const outPath = join(mkdtempSync(join(tmpdir(), 'xyte-deep-dive-out-')), 'reports', 'deep-dive.md');

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/partner/devices/') && url.includes('/commands')) {
        return new Response(JSON.stringify({ commands: [{ id: 'c1', status: 'sent' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/devices/') && url.includes('/telemetries')) {
        return new Response(JSON.stringify({ telemetries: [{ id: 'tm1', timestamp: new Date().toISOString() }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/devices/') && url.includes('/history')) {
        return new Response(JSON.stringify({ history: [{ id: 'h1', status: 'online' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/devices/')) {
        return new Response(
          JSON.stringify({
            device: { id: 'pd1', model: 'Model-X', firmware_version: '1.0.0', last_seen_at: new Date().toISOString() }
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      if (url.includes('/partner/devices')) {
        return new Response(JSON.stringify({ items: [{ id: 'pd1', status: 'offline', name: 'Partner Device' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/tickets')) {
        return new Response(
          JSON.stringify({
            items: [{ id: 'pt1', status: 'open', title: 'Partner ticket', created_at: new Date().toISOString() }]
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'ops',
      'inspect',
      'deep-dive',
      '--tenant',
      'acme',
      '--provider-scope',
      'auto',
      '--window',
      '24',
      '--render',
      'markdown',
      '--out',
      outPath
    ]);

    const stdoutOutput = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(readFileSync(outPath, 'utf8')).toBe(stdoutOutput);
    expect(stdoutOutput).toContain('# Xyte Fleet Deep Dive');
  });

  it('keeps partner deep-dive and PDF report generation unblocked when optional enrichment endpoints fail', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-partner', 'partner-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const tmpRoot = mkdtempSync(join(tmpdir(), 'xyte-partner-report-'));
    const inputPath = join(tmpRoot, 'deep-dive.json');
    const outPath = join(tmpRoot, 'partner-report.pdf');

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/partner/devices/') && url.includes('/commands')) {
        return new Response(JSON.stringify({ message: 'upstream error' }), {
          status: 503,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/devices/') && url.includes('/telemetries')) {
        return new Response(JSON.stringify({ message: 'upstream error' }), {
          status: 503,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/devices/') && url.includes('/history')) {
        return new Response(JSON.stringify({ history: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/devices/')) {
        return new Response(JSON.stringify({ device: { id: 'pd1', model: 'Model-X', firmware_version: '1.0.0' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/devices')) {
        return new Response(JSON.stringify({ items: [{ id: 'pd1', status: 'offline', name: 'Partner Device' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/tickets')) {
        return new Response(
          JSON.stringify({
            items: [{ id: 'pt1', status: 'open', title: 'Partner ticket', created_at: new Date().toISOString() }]
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'ops',
      'inspect',
      'deep-dive',
      '--tenant',
      'acme',
      '--provider-scope',
      'auto',
      '--window',
      '24',
      '--render',
      'json'
    ]);

    const inspectOutput = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const deepDive = JSON.parse(inspectOutput);
    expect(deepDive.schemaVersion).toBe('xyte.inspect.deep-dive.v1');
    writeFileSync(inputPath, JSON.stringify(deepDive, null, 2), 'utf8');

    stdout.write.mockClear();
    await program.parseAsync([
      'node',
      'xyte-cli',
      'ops',
      'report',
      'generate',
      '--tenant',
      'acme',
      '--input',
      inputPath,
      '--out',
      outPath,
      '--render',
      'pdf'
    ]);

    const report = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    expect(report.schemaVersion).toBe('xyte.report.v1');
    expect(report.format).toBe('pdf');
    const pdf = readFileSync(outPath);
    expect(pdf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('fails inspect auto scope when both providers are configured', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const orgSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'org-primary',
      fingerprint: 'sha256:org'
    });
    const partnerSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-partner',
      name: 'partner-primary',
      fingerprint: 'sha256:partner'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-org', orgSlot.slotId);
    await profileStore.setActiveKeySlot('acme', 'xyte-partner', partnerSlot.slotId);
    await secretStore.setSlotSecret('acme', 'xyte-org', orgSlot.slotId, 'org-key');
    await secretStore.setSlotSecret('acme', 'xyte-partner', partnerSlot.slotId, 'partner-key');
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'ops', 'inspect', 'fleet', '--tenant', 'acme', '--render', 'json'])
    ).rejects.toThrow('both organization and partner credentials are configured');
  });

  it('fails inspect deep-dive auto scope when both providers are configured', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const orgSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'org-primary',
      fingerprint: 'sha256:org'
    });
    const partnerSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-partner',
      name: 'partner-primary',
      fingerprint: 'sha256:partner'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-org', orgSlot.slotId);
    await profileStore.setActiveKeySlot('acme', 'xyte-partner', partnerSlot.slotId);
    await secretStore.setSlotSecret('acme', 'xyte-org', orgSlot.slotId, 'org-key');
    await secretStore.setSlotSecret('acme', 'xyte-partner', partnerSlot.slotId, 'partner-key');
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'ops',
        'inspect',
        'deep-dive',
        '--tenant',
        'acme',
        '--window',
        '24',
        '--render',
        'json'
      ])
    ).rejects.toThrow('both organization and partner credentials are configured');
  });

  it('reports organization inspect scope as unavailable when only partner credentials exist', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const partnerSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-partner',
      name: 'partner-primary',
      fingerprint: 'sha256:partner'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-partner', partnerSlot.slotId);
    await secretStore.setSlotSecret('acme', 'xyte-partner', partnerSlot.slotId, 'partner-key');
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'ops',
        'inspect',
        'fleet',
        '--tenant',
        'acme',
        '--provider-scope',
        'organization',
        '--render',
        'json'
      ])
    ).rejects.toThrow(
      'Inspect provider scope "organization" is unavailable for tenant acme. Configure an xyte-org key or run with --provider-scope partner (inspect) or --inspect-provider-scope partner (flow run).'
    );
  });

  it('reports partner inspect scope as unavailable when only organization credentials exist', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const orgSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'org-primary',
      fingerprint: 'sha256:org'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-org', orgSlot.slotId);
    await secretStore.setSlotSecret('acme', 'xyte-org', orgSlot.slotId, 'org-key');
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'ops',
        'inspect',
        'fleet',
        '--tenant',
        'acme',
        '--provider-scope',
        'partner',
        '--render',
        'json'
      ])
    ).rejects.toThrow(
      'Inspect provider scope "partner" is unavailable for tenant acme. Configure an xyte-partner key or run with --provider-scope organization (inspect) or --inspect-provider-scope organization (flow run).'
    );
  });

  it('runs inspect with explicit provider scope when both providers are configured', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const orgSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'org-primary',
      fingerprint: 'sha256:org'
    });
    const partnerSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-partner',
      name: 'partner-primary',
      fingerprint: 'sha256:partner'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-org', orgSlot.slotId);
    await profileStore.setActiveKeySlot('acme', 'xyte-partner', partnerSlot.slotId);
    await secretStore.setSlotSecret('acme', 'xyte-org', orgSlot.slotId, 'org-key');
    await secretStore.setSlotSecret('acme', 'xyte-partner', partnerSlot.slotId, 'partner-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/partner/devices')) {
        return new Response(JSON.stringify({ items: [{ id: 'pd1', status: 'online' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/tickets')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'ops',
      'inspect',
      'fleet',
      '--tenant',
      'acme',
      '--provider-scope',
      'partner',
      '--render',
      'json'
    ]);

    const parsed = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    expect(parsed.schemaVersion).toBe('xyte.inspect.fleet.v1');
    expect(parsed.totals.devices).toBe(1);
    expect(parsed.totals.spaces).toBe(0);
    expect(parsed.totals.incidents).toBe(0);
  });

  it('rejects invalid inspect provider scope values', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'ops',
        'inspect',
        'fleet',
        '--tenant',
        'acme',
        '--provider-scope',
        'bogus',
        '--render',
        'json'
      ])
    ).rejects.toThrow('Invalid inspect provider scope');
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
      incidents: [
        {
          id: 'i1',
          device_name: 'Device 1',
          status: 'active',
          space_tree_path_name: 'Overview/A',
          created_at: new Date().toISOString()
        }
      ],
      tickets: [{ id: 't1', title: 'Need help', status: 'open', created_at: new Date().toISOString(), device_id: 'd1' }]
    });
    writeFileSync(inputPath, JSON.stringify(deepDive, null, 2), 'utf8');

    await program.parseAsync([
      'node',
      'xyte-cli',
      'ops',
      'report',
      'generate',
      '--tenant',
      'acme',
      '--input',
      inputPath,
      '--out',
      outPath,
      '--render',
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
      incidents: [
        {
          id: 'i1',
          device_name: 'Device 1',
          status: 'active',
          space_tree_path_name: 'Overview/A',
          created_at: new Date().toISOString()
        }
      ],
      tickets: [{ id: 't1', title: 'Need help', status: 'open', created_at: new Date().toISOString(), device_id: 'd1' }]
    });
    writeFileSync(inputPath, JSON.stringify(deepDive, null, 2), 'utf8');

    await program.parseAsync([
      'node',
      'xyte-cli',
      'ops',
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

  it('reads setup keys from stdin in non-interactive mode', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({
      profileStore,
      secretStore,
      stdout,
      stderr,
      readStdinValue: vi.fn().mockResolvedValue('org-key')
    });

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
      '--key-stdin'
    ]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.readiness.state).toBe('ready');
  });

  it('prefers stdin over XYTE_CLI_KEY during setup', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({
      profileStore,
      secretStore,
      stdout,
      stderr,
      env: {
        ...process.env,
        XYTE_CLI_KEY: 'env-key'
      },
      readStdinValue: vi.fn().mockResolvedValue('stdin-key')
    });

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
      '--key-stdin'
    ]);

    const slots = await profileStore.listKeySlots('playground', 'xyte-org');
    const stored = await secretStore.getSlotSecret('playground', 'xyte-org', slots[0]!.slotId);
    expect(stored).toBe('stdin-key');
  });

  it('rejects conflicting secret sources during setup', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const program = createCli({
      profileStore,
      secretStore,
      stdout: { write: vi.fn() },
      stderr: { write: vi.fn() },
      readStdinValue: vi.fn().mockResolvedValue('org-key')
    });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'setup',
        'run',
        '--non-interactive',
        '--tenant',
        'playground',
        '--key',
        'inline-key',
        '--key-stdin'
      ])
    ).rejects.toThrow('Conflicting API key sources');
  });

  it('marks prompted setup keys as secret input', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const promptValue = vi.fn().mockResolvedValueOnce('org-key').mockResolvedValueOnce('playground');
    const program = createCli({
      profileStore,
      secretStore,
      stdout,
      stderr,
      isTTY: true,
      promptValue
    });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'org-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      )
    );

    await program.parseAsync(['node', 'xyte-cli', 'setup', 'run']);

    expect(promptValue).toHaveBeenCalledWith(
      expect.objectContaining({
        question: 'XYTE API key',
        secret: true
      })
    );
  });

  it('auto-populates tenant display name from organization key when name is not provided', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ name: 'Acme Organization' }), {
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
      'acme',
      '--key',
      'org-key'
    ]);

    const tenant = await profileStore.getTenant('acme');
    expect(tenant?.name).toBe('Acme Organization');
  });

  it('keeps explicit tenant name even when organization key resolves a different name', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ name: 'Acme Organization' }), {
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
      'acme',
      '--name',
      'Custom Name',
      '--key',
      'org-key'
    ]);

    const tenant = await profileStore.getTenant('acme');
    expect(tenant?.name).toBe('Custom Name');
  });

  it('auto-populates tenant display name in provider-selected organization setup', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ organization: { display_name: 'Acme Org (Advanced)' } }), {
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
      'acme-advanced',
      '--provider',
      'xyte-org',
      '--key',
      'org-key'
    ]);

    const tenant = await profileStore.getTenant('acme-advanced');
    expect(tenant?.name).toBe('Acme Org (Advanced)');
  });

  it('honors setup --provider xyte-partner in non-interactive mode without requiring --advanced', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ items: [] }), {
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
      'partner-key',
      '--provider',
      'xyte-partner'
    ]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.provider).toBe('xyte-partner');
    expect(parsed.slot.provider).toBe('xyte-partner');

    const active = await profileStore.getActiveKeySlot('playground', 'xyte-partner');
    expect(active?.provider).toBe('xyte-partner');
  });

  it('runs setup with connectivity mode never and marks connectivity step as skipped', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const fetchMock = vi.fn();

    vi.stubGlobal('fetch', fetchMock);

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
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips tenant-name lookup in advanced setup when connectivity mode is never', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const fetchMock = vi.fn();

    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'setup',
      'run',
      '--non-interactive',
      '--tenant',
      'acme-advanced',
      '--provider',
      'xyte-org',
      '--key',
      'org-key',
      '--connectivity',
      'never'
    ]);

    const tenant = await profileStore.getTenant('acme-advanced');
    expect(tenant?.name).toBe('acme-advanced');
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('does not register removed install wrapper commands', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const installCommand = program.commands.find((command) => command.name() === 'install');
    expect(installCommand).toBeUndefined();
  });

  it('installs skill to target workspace with --no-setup', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const target = mkdtempSync(join(tmpdir(), 'xyte-cli-skill-install-'));

    await program.parseAsync(['node', 'xyte-cli', 'init', '--target', target, '--no-setup']);

    expect(existsSync(join(target, '.claude', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, '.github', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, '.agents', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Workspace target');
    expect(output).toContain('Skill install summary');
  });

  it('runs init with setup when XYTE_CLI_KEY is present', async () => {
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
      await program.parseAsync(['node', 'xyte-cli', 'init', '--target', target]);
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

  it('keeps init successful when setup credentials are missing', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const target = mkdtempSync(join(tmpdir(), 'xyte-cli-install-soft-init-'));

    await program.parseAsync(['node', 'xyte-cli', 'init', '--target', target]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    expect(output).toContain('Skill install summary');
    expect(output).toContain('Setup skipped: no API key was provided.');
    expect(output).toContain('Run xyte-cli setup run --tenant <tenant-id>');
    expect(output).not.toContain('--key-stdin --tenant');
  });

  it('fails init when --require-setup is used without credentials', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });
    const target = mkdtempSync(join(tmpdir(), 'xyte-cli-install-strict-init-'));

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'init', '--target', target, '--require-setup'])
    ).rejects.toThrow('Missing API key for init setup');
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
        'init',
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
    const promptValue = vi.fn().mockResolvedValueOnce('project').mockResolvedValueOnce('claude,codex');
    const program = createCli({
      profileStore,
      secretStore,
      stdout,
      stderr,
      isTTY: true,
      promptValue
    });
    const target = mkdtempSync(join(tmpdir(), 'xyte-cli-install-interactive-'));

    await program.parseAsync(['node', 'xyte-cli', 'init', '--target', target, '--no-setup']);

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
      program.parseAsync(['node', 'xyte-cli', 'init', '--scope', 'project', '--agents', 'claude,unknown', '--no-setup'])
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
      'init',
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
      'init',
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
      'init',
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

    await expect(program.parseAsync(['node', 'xyte-cli', 'init', '--target', target, '--no-setup'])).rejects.toThrow(
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
    const tenantCommand = program.commands.find((command) => command.name() === 'tenant');
    const profileCommand = program.commands.find((command) => command.name() === 'profile');
    expect(authCommand).toBeUndefined();
    expect(tenantCommand).toBeUndefined();
    expect(profileCommand).toBeUndefined();
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
        fetchImpl: vi.fn().mockImplementation(
          async () =>
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
      if (/^xyte-cli(?:\.cmd)?$/.test(command)) {
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
        fetchImpl: vi.fn().mockImplementation(
          async () =>
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

  it('runs flow setup-readiness in default plan mode and writes a structured bundle', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'primary',
      fingerprint: 'sha256:test'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-org', slot.slotId);

    const secretStore = new MemorySecretStore();
    await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const outDir = mkdtempSync(join(tmpdir(), 'xyte-flow-run-cli-'));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/organization/info')) {
          return new Response(JSON.stringify({ id: 'org-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/devices')) {
          return new Response(JSON.stringify({ items: [{ id: 'dev-1', status: 'online' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/spaces')) {
          return new Response(JSON.stringify({ items: [{ id: 'sp-1', name: 'HQ', space_type: 'site' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/incidents')) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/tickets')) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/partner/tickets')) {
          return new Response(JSON.stringify({ items: [] }), {
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

    await program.parseAsync([
      'node',
      'xyte-cli',
      'flow',
      'run',
      'flow.setup-readiness-10m',
      '--tenant',
      'acme',
      '--out-dir',
      outDir
    ]);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.schemaVersion).toBe('xyte.flow.run.v1');
    expect(parsed.mode).toBe('plan');
    expect(parsed.outcome).toBe('completed');
    expect(parsed.steps.map((item: any) => item.stepId)).toEqual([
      'setup_status',
      'config_doctor',
      'status_fast',
      'inspect_fleet_setup'
    ]);
    expect(parsed.steps.every((item: any) => item.status === 'completed')).toBe(true);
    expect(parsed.cursor.nextStepIndex).toBe(parsed.steps.length);
    expect(parsed.resumeCommand).toBeUndefined();
    expect(existsSync(parsed.manifestPath)).toBe(true);
    expect(existsSync(parsed.inputsPath)).toBe(true);
    expect(existsSync(parsed.decisionsPath)).toBe(true);
    expect(existsSync(parsed.errorsPath)).toBe(true);
    expect(existsSync(parsed.watchFramesPath)).toBe(true);
  });

  it('rejects invalid flow --inspect-provider-scope values', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const program = createCli({ profileStore, secretStore, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync([
        'node',
        'xyte-cli',
        'flow',
        'run',
        'flow.setup-readiness-10m',
        '--tenant',
        'acme',
        '--inspect-provider-scope',
        'bogus'
      ])
    ).rejects.toThrow('Invalid inspect provider scope');
  });

  it('runs flow.daily-deep-dive-report in partner-only mode with explicit inspect provider scope', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const partnerSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-partner',
      name: 'partner-primary',
      fingerprint: 'sha256:partner'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-partner', partnerSlot.slotId);
    await secretStore.setSlotSecret('acme', 'xyte-partner', partnerSlot.slotId, 'partner-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const outDir = mkdtempSync(join(tmpdir(), 'xyte-flow-run-daily-partner-'));

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/partner/devices')) {
        return new Response(JSON.stringify({ items: [{ id: 'pd-1', status: 'online', name: 'Partner Device' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/tickets')) {
        return new Response(
          JSON.stringify({ items: [{ id: 'pt-1', status: 'open', created_at: new Date().toISOString() }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'flow',
      'run',
      'flow.daily-deep-dive-report',
      '--tenant',
      'acme',
      '--inspect-provider-scope',
      'partner',
      '--out-dir',
      outDir
    ]);

    const parsed = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    expect(parsed.outcome).toBe('pending_gate');
    expect(parsed.resumeCommand).toContain('--inspect-provider-scope partner');
    expect(parsed.steps.find((item: any) => item.stepId === 'inspect_deep_dive_daily')?.status).toBe('completed');
    expect(parsed.steps.find((item: any) => item.stepId === 'report_daily')?.status).toBe('completed');
    expect(parsed.steps.find((item: any) => item.stepId === 'inspect_fleet_daily')?.status).toBe('completed');
    expect(parsed.classifications.needs_data).toBe(0);
    expect(parsed.classifications.bug).toBe(0);
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.every((url) => url.includes('/partner/'))).toBe(true);
  });

  it('returns needs_input when flow inspect scope is auto and both providers are configured', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const orgSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'org-primary',
      fingerprint: 'sha256:org'
    });
    const partnerSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-partner',
      name: 'partner-primary',
      fingerprint: 'sha256:partner'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-org', orgSlot.slotId);
    await profileStore.setActiveKeySlot('acme', 'xyte-partner', partnerSlot.slotId);
    await secretStore.setSlotSecret('acme', 'xyte-org', orgSlot.slotId, 'org-key');
    await secretStore.setSlotSecret('acme', 'xyte-partner', partnerSlot.slotId, 'partner-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const outDir = mkdtempSync(join(tmpdir(), 'xyte-flow-run-daily-ambiguous-'));

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/organization/info')) {
        return new Response(JSON.stringify({ id: 'org-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'flow',
      'run',
      'flow.daily-deep-dive-report',
      '--tenant',
      'acme',
      '--out-dir',
      outDir
    ]);

    const parsed = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    expect(parsed.outcome).toBe('needs_input');
    expect(parsed.classifications.needs_data).toBe(1);
    expect(parsed.classifications.bug).toBe(0);
    const inspectStep = parsed.steps.find((item: any) => item.stepId === 'inspect_deep_dive_daily');
    expect(inspectStep?.status).toBe('failed');
    expect(String(inspectStep?.error?.detail ?? '')).toContain(
      'both organization and partner credentials are configured'
    );
  });

  it('unblocks flow.daily-deep-dive-report with explicit partner inspect scope when both providers are configured', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    const orgSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'org-primary',
      fingerprint: 'sha256:org'
    });
    const partnerSlot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-partner',
      name: 'partner-primary',
      fingerprint: 'sha256:partner'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-org', orgSlot.slotId);
    await profileStore.setActiveKeySlot('acme', 'xyte-partner', partnerSlot.slotId);
    await secretStore.setSlotSecret('acme', 'xyte-org', orgSlot.slotId, 'org-key');
    await secretStore.setSlotSecret('acme', 'xyte-partner', partnerSlot.slotId, 'partner-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const outDir = mkdtempSync(join(tmpdir(), 'xyte-flow-run-daily-both-partner-'));

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/organization/info')) {
        return new Response(JSON.stringify({ id: 'org-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/devices')) {
        return new Response(JSON.stringify({ items: [{ id: 'pd-1', status: 'online', name: 'Partner Device' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/tickets')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await program.parseAsync([
      'node',
      'xyte-cli',
      'flow',
      'run',
      'flow.daily-deep-dive-report',
      '--tenant',
      'acme',
      '--inspect-provider-scope',
      'partner',
      '--out-dir',
      outDir
    ]);

    const parsed = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    expect(parsed.outcome).toBe('pending_gate');
    expect(parsed.classifications.needs_data).toBe(0);
    expect(parsed.classifications.bug).toBe(0);
    expect(parsed.steps.find((item: any) => item.stepId === 'inspect_deep_dive_daily')?.status).toBe('completed');
    expect(parsed.steps.find((item: any) => item.stepId === 'report_daily')?.status).toBe('completed');
    expect(parsed.steps.find((item: any) => item.stepId === 'inspect_fleet_daily')?.status).toBe('completed');
  });

  it('stops write-capable flow at gate in --plan and advances one gate in --apply --resume', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const outDir = mkdtempSync(join(tmpdir(), 'xyte-flow-run-gates-'));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.includes('/organization/incidents')) {
          return new Response(
            JSON.stringify({ items: [{ id: 'inc-1', uuid: 'inc-1', device_id: 'dev-1', status: 'active' }] }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' }
            }
          );
        }
        if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify({ items: [{ command: 'restart' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
          return new Response(JSON.stringify({ ok: true }), {
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

    await program.parseAsync([
      'node',
      'xyte-cli',
      'flow',
      'run',
      'flow.guided-remediation',
      '--tenant',
      'acme',
      '--plan',
      '--out-dir',
      outDir,
      '--var',
      'device_id=dev-1',
      '--var',
      'command=restart'
    ]);

    const firstOutput = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const first = JSON.parse(firstOutput);
    expect(first.outcome).toBe('pending_gate');
    expect(first.nextResumeStepId).toBe('gate_send_command');

    stdout.write.mockClear();
    await program.parseAsync([
      'node',
      'xyte-cli',
      'flow',
      'run',
      'flow.guided-remediation',
      '--tenant',
      'acme',
      '--apply',
      '--resume',
      first.runId,
      '--out-dir',
      outDir,
      '--var',
      'device_id=dev-1',
      '--var',
      'command=restart'
    ]);
    const second = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    expect(second.outcome).toBe('pending_gate');
    expect(second.nextResumeStepId).toBe('gate_update_device');
    const secondStepStatus = new Map<string, string>(second.steps.map((item: any) => [item.stepId, item.status]));
    expect(secondStepStatus.get('gate_send_command')).toBe('gate_approved');
    expect(secondStepStatus.get('commands_send')).toBe('completed');

    stdout.write.mockClear();
    await program.parseAsync([
      'node',
      'xyte-cli',
      'flow',
      'run',
      'flow.guided-remediation',
      '--tenant',
      'acme',
      '--apply',
      '--resume',
      first.runId,
      '--out-dir',
      outDir,
      '--var',
      'device_id=dev-1',
      '--var',
      'command=restart'
    ]);
    const third = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    expect(third.outcome).toBe('pending_gate');
    expect(third.nextResumeStepId).toBe('gate_ticket_message');
    const thirdStepStatus = new Map<string, string>(third.steps.map((item: any) => [item.stepId, item.status]));
    expect(thirdStepStatus.get('watch_before')).toBe('completed');
    expect(thirdStepStatus.get('commands_get')).toBe('completed');
    expect(thirdStepStatus.get('gate_send_command')).toBe('gate_approved');
    expect(thirdStepStatus.get('commands_send')).toBe('completed');
    expect(thirdStepStatus.get('gate_update_device')).toBe('gate_approved');
    expect(thirdStepStatus.get('device_update')).toBe('completed');
    expect(thirdStepStatus.get('device_get_verify')).toBe('completed');
    expect(thirdStepStatus.get('gate_ticket_message')).toBe('gate_pending');
  });

  it('merges flow context from --context-json and --var with var precedence', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const secretStore = new MemorySecretStore();
    await secretStore.setSecret('acme', 'xyte-org', 'org-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const outDir = mkdtempSync(join(tmpdir(), 'xyte-flow-run-context-'));
    const contextPath = join(outDir, 'context.json');
    writeFileSync(contextPath, JSON.stringify({ device_id: 'dev-from-file', command: 'restart' }), 'utf8');

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/organization/incidents')) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/devices/dev-from-var/commands')) {
          return new Response(JSON.stringify({ items: [] }), {
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

    await program.parseAsync([
      'node',
      'xyte-cli',
      'flow',
      'run',
      'flow.guided-remediation',
      '--tenant',
      'acme',
      '--plan',
      '--out-dir',
      outDir,
      '--context-json',
      contextPath,
      '--var',
      'device_id=dev-from-var'
    ]);

    const output = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
    const inputs = JSON.parse(readFileSync(output.inputsPath, 'utf8'));
    expect(inputs.context.device_id).toBe('dev-from-var');
    expect(inputs.context.command).toBe('restart');
  });

  it('supports custom flow create/edit/share/import and runs custom alias flow', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'primary',
      fingerprint: 'sha256:test'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-org', slot.slotId);
    const secretStore = new MemorySecretStore();
    await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, secretStore, stdout, stderr });
    const tempConfig = mkdtempSync(join(tmpdir(), 'xyte-flow-config-'));
    const previousConfig = process.env.XYTE_CLI_CONFIG_DIR;
    process.env.XYTE_CLI_CONFIG_DIR = tempConfig;
    const outDir = mkdtempSync(join(tmpdir(), 'xyte-flow-run-custom-'));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/organization/info')) {
          return new Response(JSON.stringify({ id: 'org-1' }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/devices')) {
          return new Response(JSON.stringify({ items: [{ id: 'dev-1', status: 'online' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/spaces')) {
          return new Response(JSON.stringify({ items: [{ id: 'sp-1', name: 'HQ', space_type: 'site' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/incidents')) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/tickets')) {
          return new Response(JSON.stringify({ items: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/partner/tickets')) {
          return new Response(JSON.stringify({ items: [] }), {
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

    try {
      await program.parseAsync([
        'node',
        'xyte-cli',
        'flow',
        'create',
        'flow.custom-daily',
        '--based-on',
        'flow.daily-deep-dive-report',
        '--title',
        'Custom Daily',
        '--var',
        'window_hours=12'
      ]);
      const created = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
      expect(created.id).toBe('flow.custom-daily');
      expect(created.basedOn).toBe('flow.daily-deep-dive-report');

      stdout.write.mockClear();
      await program.parseAsync(['node', 'xyte-cli', 'flow', 'list']);
      const listed = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
      expect(listed.custom.some((item: any) => item.id === 'flow.custom-daily')).toBe(true);

      stdout.write.mockClear();
      await program.parseAsync([
        'node',
        'xyte-cli',
        'flow',
        'edit',
        'flow.custom-daily',
        '--description',
        'Daily report for AI agent context',
        '--var',
        'region=us'
      ]);
      const edited = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
      expect(edited.defaults.region).toBe('us');

      const sharePath = join(outDir, 'flow.custom-daily.json');
      stdout.write.mockClear();
      await program.parseAsync(['node', 'xyte-cli', 'flow', 'share', 'flow.custom-daily', '--out', sharePath]);
      expect(existsSync(sharePath)).toBe(true);

      stdout.write.mockClear();
      await program.parseAsync(['node', 'xyte-cli', 'flow', 'import', '--file', sharePath, '--force']);
      const imported = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
      expect(imported.id).toBe('flow.custom-daily');

      stdout.write.mockClear();
      await program.parseAsync([
        'node',
        'xyte-cli',
        'flow',
        'run',
        'flow.custom-daily',
        '--tenant',
        'acme',
        '--out-dir',
        outDir
      ]);
      const runOutput = JSON.parse(stdout.write.mock.calls.map((call) => String(call[0])).join(''));
      expect(runOutput.resolvedFlowId).toBe('flow.daily-deep-dive-report');
      expect(runOutput.outcome).toBe('pending_gate');
      const runStepStatus = new Map<string, string>(runOutput.steps.map((item: any) => [item.stepId, item.status]));
      expect(runStepStatus.get('setup_status_daily')).toBe('completed');
      expect(runStepStatus.get('inspect_deep_dive_daily')).toBe('completed');
      expect(runStepStatus.get('report_daily')).toBe('completed');
      expect(runStepStatus.get('inspect_fleet_daily')).toBe('completed');
      expect(runStepStatus.get('decision_distribute_or_escalate')).toBe('gate_pending');

      const deepDiveStep = runOutput.steps.find((item: any) => item.stepId === 'inspect_deep_dive_daily');
      expect(typeof deepDiveStep?.artifactPath).toBe('string');
      const deepDiveArtifact = JSON.parse(readFileSync(deepDiveStep.artifactPath, 'utf8'));
      expect(deepDiveArtifact.windowHours).toBe(12);
    } finally {
      if (previousConfig === undefined) {
        delete process.env.XYTE_CLI_CONFIG_DIR;
      } else {
        process.env.XYTE_CLI_CONFIG_DIR = previousConfig;
      }
    }
  });
});
