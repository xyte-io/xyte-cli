import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createCli } from '../src/cli/index';
import { MemoryKeychain } from '../src/secure/keychain';
import { MemoryProfileStore } from './support/memory-profile-store';
import { buildDeepDive } from '../src/workflows/fleet-insights';

describe('cli integration', () => {
  it('allows read-only calls without --allow-write', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const keychain = new MemoryKeychain();
    await keychain.setSecret('acme', 'xyte-device', 'device-key');

    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const program = createCli({ profileStore, keychain, stdout, stderr });

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
      '{"device_id":"dev-1"}'
    ]);

    expect(stdout.write).toHaveBeenCalled();
  });

  it('blocks write calls without --allow-write', async () => {
    const profileStore = new MemoryProfileStore();
    const keychain = new MemoryKeychain();

    const program = createCli({ profileStore, keychain, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'call', 'organization.commands.sendCommand'])
    ).rejects.toThrow('--allow-write');
  });

  it('shows one-line remediation when running bare xyte-cli without setup in non-interactive mode', async () => {
    const profileStore = new MemoryProfileStore();
    const keychain = new MemoryKeychain();

    const program = createCli({ profileStore, keychain, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(program.parseAsync(['node', 'xyte-cli'])).rejects.toThrow(
      'Setup required. Run: xyte-cli setup run --non-interactive --tenant default --key "$XYTE_CLI_KEY".'
    );
  });

  it('launches dashboard directly when bare xyte-cli is already configured', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme', name: 'Acme' });
    await profileStore.setActiveTenant('acme');
    const keychain = new MemoryKeychain();
    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'primary',
      fingerprint: 'sha256:test'
    });
    await keychain.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key');
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
      keychain,
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
    const keychain = new MemoryKeychain();

    const program = createCli({ profileStore, keychain, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    await expect(
      program.parseAsync(['node', 'xyte-cli', 'call', 'organization.commands.cancelCommand', '--allow-write'])
    ).rejects.toThrow('--confirm organization.commands.cancelCommand');
  });

  it('passes headless tui options through cli command', async () => {
    const profileStore = new MemoryProfileStore();
    const keychain = new MemoryKeychain();
    const runTui = vi.fn().mockResolvedValue(undefined);

    const program = createCli({
      profileStore,
      keychain,
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
    const keychain = new MemoryKeychain();
    const runTui = vi.fn().mockResolvedValue(undefined);
    const program = createCli({
      profileStore,
      keychain,
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
    const keychain = new MemoryKeychain();
    const runTui = vi.fn().mockResolvedValue(undefined);

    const program = createCli({
      profileStore,
      keychain,
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
    const keychain = new MemoryKeychain();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const program = createCli({ profileStore, keychain, stdout, stderr });
    await program.parseAsync(['node', 'xyte-cli', 'setup', 'status', '--format', 'json']);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(parsed.state).toBe('needs_setup');
  });

  it('supports named auth key lifecycle basics', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const keychain = new MemoryKeychain();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };

    const program = createCli({ profileStore, keychain, stdout, stderr });
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
    const keychain = new MemoryKeychain();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, keychain, stdout, stderr });

    await program.parseAsync(['node', 'xyte-cli', 'doctor', 'install', '--format', 'json']);

    const output = stdout.write.mock.calls.map((call) => String(call[0])).join('');
    const parsed = JSON.parse(output);
    expect(['ok', 'missing', 'mismatch']).toContain(parsed.status);
    expect(parsed.expectedPath).toContain('bin/xyte-cli');
  });

  it('emits call envelope when output-mode is envelope', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const keychain = new MemoryKeychain();
    await keychain.setSecret('acme', 'xyte-device', 'device-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, keychain, stdout, stderr });

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
      '{"device_id":"dev-1"}',
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
    const keychain = new MemoryKeychain();
    await keychain.setSecret('acme', 'xyte-org', 'org-key');
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, keychain, stdout, stderr });

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
    const keychain = new MemoryKeychain();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, keychain, stdout, stderr });
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
    const keychain = new MemoryKeychain();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, keychain, stdout, stderr });
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
    const keychain = new MemoryKeychain();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, keychain, stdout, stderr });

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

  it('installs skill to target workspace with --no-setup', async () => {
    const profileStore = new MemoryProfileStore();
    const keychain = new MemoryKeychain();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, keychain, stdout, stderr });
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
    const keychain = new MemoryKeychain();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, keychain, stdout, stderr });
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
    const keychain = new MemoryKeychain();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, keychain, stdout, stderr });
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
    const keychain = new MemoryKeychain();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const promptValue = vi
      .fn()
      .mockResolvedValueOnce('project')
      .mockResolvedValueOnce('claude,codex');
    const program = createCli({
      profileStore,
      keychain,
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
    const keychain = new MemoryKeychain();
    const program = createCli({ profileStore, keychain, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

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
    const keychain = new MemoryKeychain();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, keychain, stdout, stderr });
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
    const keychain = new MemoryKeychain();
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const program = createCli({ profileStore, keychain, stdout, stderr });
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
    const keychain = new MemoryKeychain();
    const program = createCli({ profileStore, keychain, stdout: { write: vi.fn() }, stderr: { write: vi.fn() } });

    const authCommand = program.commands.find((command) => command.name() === 'auth');
    expect(authCommand).toBeDefined();
    expect(authCommand?.commands.map((command) => command.name())).not.toContain('set-key');
    expect(authCommand?.commands.map((command) => command.name())).not.toContain('clear-key');
  });
});
