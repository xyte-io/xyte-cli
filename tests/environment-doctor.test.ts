import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildEnvironmentDoctorReport,
  formatEnvironmentDoctorText,
  type EnvironmentDoctorOptions,
  type EnvironmentPathCheck
} from '../src/workflows/environment-doctor';

const writableProbe = async (dirPath: string): Promise<EnvironmentPathCheck> => ({
  status: 'ok',
  path: dirPath,
  message: 'Writable.'
});

function baseOptions(overrides: Partial<EnvironmentDoctorOptions> = {}): EnvironmentDoctorOptions {
  return {
    platform: 'linux',
    arch: 'x64',
    cwd: '/workspace',
    homeDir: '/home/user',
    tempDir: '/tmp',
    configDir: '/home/user/.config/xyte-cli',
    nodePath: '/usr/bin/node',
    nodeVersion: 'v22.13.0',
    now: new Date('2026-06-09T00:00:00.000Z'),
    commandResolver: (command) =>
      ({ npm: '/usr/bin/npm', npx: '/usr/bin/npx', 'xyte-cli': '/usr/local/bin/xyte-cli' })[command],
    writableProbe,
    secretStoreDiagnostics: async () => ({
      selector: 'auto',
      backend: 'keychain',
      secretStore: 'xyte-cli',
      legacySecretStore: ''
    }),
    ...overrides
  };
}

describe('environment doctor', () => {
  it('recommends existing mode with ok status on a healthy machine with xyte-cli on PATH', async () => {
    const report = await buildEnvironmentDoctorReport(baseOptions());

    expect(report.schemaVersion).toBe('xyte.doctor.environment.v1');
    expect(report.generatedAtUtc).toBe('2026-06-09T00:00:00.000Z');
    expect(report.status).toBe('ok');
    expect(report.environment.xyteCli).toEqual({ available: true, path: '/usr/local/bin/xyte-cli' });
    expect(report.environment.node.version).toBe('v22.13.0');
    expect(report.checks.network.status).toBe('skipped');
    expect(report.recommendations.mode).toBe('existing');
    expect(report.recommendations.commandPrefix).toBe('xyte-cli');
    expect(report.recommendations.nextCommand).toBe('xyte-cli doctor environment --format json');
    expect(report.recommendations.commands?.doctor).toBe('xyte-cli doctor environment --format json');
  });

  it('recommends npx mode when xyte-cli is missing but npx is available', async () => {
    const report = await buildEnvironmentDoctorReport(
      baseOptions({
        commandResolver: (command) => ({ npm: '/usr/bin/npm', npx: '/usr/bin/npx' })[command]
      })
    );

    expect(report.environment.xyteCli.available).toBe(false);
    expect(report.recommendations.mode).toBe('npx');
    expect(report.recommendations.commandPrefix).toBe('npx -y @xyteai/cli@latest');
    expect(report.recommendations.nextCommand).toBe('npx -y @xyteai/cli@latest doctor environment --format json');
  });

  it('recommends workspace-local mode when npx is missing but npm can install into the workspace', async () => {
    const report = await buildEnvironmentDoctorReport(
      baseOptions({
        commandResolver: (command) => ({ npm: '/usr/bin/npm' })[command]
      })
    );

    expect(report.recommendations.mode).toBe('workspace-local');
    expect(report.recommendations.commandPrefix).toBe('./.xyte-cli/runtime/node_modules/.bin/xyte-cli');
    expect(report.recommendations.installCommand).toBe('npm install --prefix ./.xyte-cli/runtime @xyteai/cli@latest');
    expect(report.status).toBe('restricted');
  });

  it('emits Windows command paths for workspace-local mode on win32', async () => {
    const report = await buildEnvironmentDoctorReport(
      baseOptions({
        platform: 'win32',
        cwd: 'C:\\workspace',
        homeDir: 'C:\\Users\\user',
        tempDir: 'C:\\Temp',
        configDir: 'C:\\Users\\user\\AppData\\Roaming\\xyte-cli',
        commandResolver: (command) => ({ npm: 'C:\\Program Files\\nodejs\\npm.cmd' })[command]
      })
    );

    expect(report.recommendations.mode).toBe('workspace-local');
    expect(report.recommendations.commandPrefix).toBe('.\\.xyte-cli\\runtime\\node_modules\\.bin\\xyte-cli.cmd');
    expect(report.recommendations.commands?.setupStdin).toContain('Get-Content');
  });

  it('reports blocked when Node does not satisfy the minimum version', async () => {
    const report = await buildEnvironmentDoctorReport(baseOptions({ nodeVersion: 'v18.19.0' }));

    expect(report.checks.nodeVersion.status).toBe('blocked');
    expect(report.recommendations.mode).toBe('blocked');
    expect(report.status).toBe('blocked');
    expect(report.recommendations.commandPrefix).toBeUndefined();
    expect(report.recommendations.commands).toBeUndefined();
  });

  it('reports blocked when no install path exists at all', async () => {
    const report = await buildEnvironmentDoctorReport(
      baseOptions({
        commandResolver: () => undefined
      })
    );

    expect(report.recommendations.mode).toBe('blocked');
    expect(report.status).toBe('blocked');
  });

  it('does not treat an ephemeral npx cache entry as an existing install', async () => {
    const report = await buildEnvironmentDoctorReport(
      baseOptions({
        commandResolver: (command) =>
          ({
            npm: '/usr/bin/npm',
            npx: '/usr/bin/npx',
            'xyte-cli': '/home/user/.npm/_npx/abc123/node_modules/.bin/xyte-cli'
          })[command]
      })
    );

    expect(report.recommendations.mode).toBe('npx');
  });

  it('treats a durable currentCommandPath as an existing install when PATH lookup fails', async () => {
    const report = await buildEnvironmentDoctorReport(
      baseOptions({
        currentCommandPath: '/opt/tools/xyte-cli',
        commandResolver: (command) => ({ npm: '/usr/bin/npm', npx: '/usr/bin/npx' })[command]
      })
    );

    expect(report.environment.xyteCli).toEqual({ available: true, path: '/opt/tools/xyte-cli' });
    expect(report.recommendations.mode).toBe('existing');
    expect(report.recommendations.commandPrefix).toBe('/opt/tools/xyte-cli');
  });

  it('prefixes a script-file currentCommandPath with node so the recommendation is runnable', async () => {
    const report = await buildEnvironmentDoctorReport(
      baseOptions({
        currentCommandPath: '/opt/tools/dist/bin/xyte-cli.js',
        commandResolver: (command) => ({ npm: '/usr/bin/npm', npx: '/usr/bin/npx' })[command]
      })
    );

    expect(report.recommendations.mode).toBe('existing');
    expect(report.recommendations.commandPrefix).toBe('node /opt/tools/dist/bin/xyte-cli.js');
    expect(report.recommendations.nextCommand).toBe(
      'node /opt/tools/dist/bin/xyte-cli.js doctor environment --format json'
    );
  });

  it('treats a relative config directory as inside the workspace', async () => {
    const report = await buildEnvironmentDoctorReport(baseOptions({ configDir: './xyte-config' }));

    expect(report.checks.configDirOutsideWorkspace.status).toBe('restricted');
    expect(report.status).toBe('restricted');
  });

  it('restricts when the config directory is inside the workspace', async () => {
    const report = await buildEnvironmentDoctorReport(baseOptions({ configDir: '/workspace/.xyte-config' }));

    expect(report.checks.configDirOutsideWorkspace.status).toBe('restricted');
    expect(report.status).toBe('restricted');
    expect(report.recommendations.notes).toContain(
      'Use XYTE_CLI_CONFIG_DIR outside the workspace or under a temp directory for setup.'
    );
  });

  it('restricts when only file-based secret storage is available', async () => {
    const report = await buildEnvironmentDoctorReport(
      baseOptions({
        secretStoreDiagnostics: async () => ({
          selector: 'auto',
          backend: 'file',
          secretStore: '/home/user/.config/xyte-cli/secrets.json',
          legacySecretStore: ''
        })
      })
    );

    expect(report.checks.secretStore.status).toBe('restricted');
    expect(report.status).toBe('restricted');
    expect(report.recommendations.notes).toContain(
      'Use --key-stdin, --key-command, or --key-file <path-outside-workspace> for non-interactive setup.'
    );
  });

  it('restricts when HOME is not writable', async () => {
    const report = await buildEnvironmentDoctorReport(
      baseOptions({
        writableProbe: async (dirPath) =>
          dirPath === '/home/user'
            ? { status: 'blocked', path: dirPath, message: 'EACCES' }
            : { status: 'ok', path: dirPath, message: 'Writable.' }
      })
    );

    expect(report.status).toBe('restricted');
    expect(report.recommendations.notes).toContain(
      'HOME is not writable; avoid relying on shell profile or global PATH persistence.'
    );
  });

  it('reports HOME as unavailable when the home directory is unknown', async () => {
    const report = await buildEnvironmentDoctorReport(baseOptions({ homeDir: '' }));

    expect(report.environment.home).toBeNull();
    expect(report.checks.homeWritable.status).toBe('blocked');
    expect(report.status).toBe('restricted');
  });

  it('blocks when no writable location for config exists anywhere', async () => {
    const report = await buildEnvironmentDoctorReport(
      baseOptions({
        writableProbe: async (dirPath) =>
          dirPath === '/workspace' || dirPath === '/workspace/.xyte-cli/runtime'
            ? { status: 'ok', path: dirPath, message: 'Writable.' }
            : { status: 'blocked', path: dirPath, message: 'EROFS' }
      })
    );

    expect(report.status).toBe('blocked');
    expect(report.recommendations.notes).toContain(
      'Temp directory is not writable; provide a writable config directory before setup.'
    );
  });

  it('runs the network probe only when checkNetwork is set', async () => {
    const report = await buildEnvironmentDoctorReport(
      baseOptions({
        checkNetwork: true,
        networkProbe: async () => ({
          status: 'ok',
          url: 'https://registry.npmjs.org/@xyteai%2fcli/latest',
          message: 'npm registry reachable.'
        })
      })
    );

    expect(report.checks.network.status).toBe('ok');
  });

  it('does not recommend npx or workspace-local when the registry is unreachable', async () => {
    const report = await buildEnvironmentDoctorReport(
      baseOptions({
        commandResolver: (command) => ({ npm: '/usr/bin/npm', npx: '/usr/bin/npx' })[command],
        checkNetwork: true,
        networkProbe: async () => ({
          status: 'blocked',
          url: 'https://registry.npmjs.org/@xyteai%2fcli/latest',
          message: 'fetch failed'
        })
      })
    );

    expect(report.checks.network.status).toBe('blocked');
    expect(report.recommendations.mode).toBe('blocked');
  });

  it('formats a concise text report', async () => {
    const report = await buildEnvironmentDoctorReport(
      baseOptions({
        commandResolver: (command) => ({ npm: '/usr/bin/npm' })[command]
      })
    );

    const text = formatEnvironmentDoctorText(report);

    expect(text).toContain('Status: restricted');
    expect(text).toContain('Mode: workspace-local');
    expect(text).toContain(
      'Next command: ./.xyte-cli/runtime/node_modules/.bin/xyte-cli doctor environment --format json'
    );
    expect(text).toContain('Install command: npm install --prefix ./.xyte-cli/runtime @xyteai/cli@latest');
    expect(text).toContain('- Do not paste API keys into AI chat or store API keys inside the repo.');
    expect(text.endsWith('\n')).toBe(true);
  });

  describe('default writable probe (real filesystem)', () => {
    function realFsOptions(overrides: Partial<EnvironmentDoctorOptions>): EnvironmentDoctorOptions {
      return baseOptions({ platform: process.platform, writableProbe: undefined, ...overrides });
    }

    it('probes an existing directory without leaving files behind', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'xyte-doctor-'));

      const report = await buildEnvironmentDoctorReport(
        realFsOptions({ cwd: dir, homeDir: dir, tempDir: dir, configDir: dir })
      );

      expect(report.checks.tempWritable).toEqual({ status: 'ok', path: dir, message: 'Writable.' });
      expect(readdirSync(dir)).toEqual([]);
    });

    it('creates missing directories for the probe and removes them afterwards', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'xyte-doctor-'));
      const configDir = join(dir, 'deep', 'nested', 'xyte-cli');

      const report = await buildEnvironmentDoctorReport(
        realFsOptions({ cwd: dir, homeDir: dir, tempDir: dir, configDir })
      );

      expect(report.checks.configDirWritable.status).toBe('ok');
      expect(existsSync(join(dir, 'deep'))).toBe(false);
    });

    it('keeps pre-existing directories when probing nested paths', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'xyte-doctor-'));
      const configDir = join(dir, 'existing', 'xyte-cli');
      writeFileSync(join(dir, 'marker.txt'), 'keep', 'utf8');

      const report = await buildEnvironmentDoctorReport(
        realFsOptions({ cwd: dir, homeDir: dir, tempDir: dir, configDir })
      );

      expect(report.checks.configDirWritable.status).toBe('ok');
      expect(existsSync(join(dir, 'marker.txt'))).toBe(true);
      expect(existsSync(join(dir, 'existing'))).toBe(false);
    });

    it('reports blocked when the directory cannot be created', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'xyte-doctor-'));
      const filePath = join(dir, 'a-file');
      writeFileSync(filePath, 'not a dir', 'utf8');

      const report = await buildEnvironmentDoctorReport(
        realFsOptions({ cwd: dir, homeDir: dir, tempDir: dir, configDir: join(filePath, 'xyte-cli') })
      );

      expect(report.checks.configDirWritable.status).toBe('blocked');
      expect(report.checks.configDirWritable.message).not.toBe('');
    });
  });
});
