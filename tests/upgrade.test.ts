import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyUpgrade, buildWingetConsoleArgs, checkForUpgrade, resolveCmdPath, resolveWingetPath } from '../src/cli/upgrade';
import { maybeNotifyUpdateAvailable } from '../src/cli/update-notifier';
import { compareSemver } from '../src/contracts/semver';

describe('upgrade utilities', () => {
  it('compares semver strings correctly', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareSemver('1.2.3', '1.2.3-beta.1')).toBeGreaterThan(0);
    expect(compareSemver('1.2.3-beta.1', '1.2.3-beta.2')).toBeLessThan(0);
  });

  it('uses override latest version without calling registry', async () => {
    const fetchImpl = vi.fn();

    const result = await checkForUpgrade(
      {
        packageName: '@xyteai/cli',
        latestVersionOverride: '0.5.0'
      },
      {
        fetchImpl: fetchImpl as any,
        getCurrentVersion: () => '0.4.0',
        getInstallChannel: () => ({ kind: 'npm' })
      }
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.installChannel).toBe('npm');
    expect(result.latestVersion).toBe('0.5.0');
    expect(result.upToDate).toBe(false);
  });

  it('recommends winget updates for Windows MSI installs, using the fixed package id', async () => {
    const result = await checkForUpgrade(
      {
        packageName: '@xyteai/cli',
        latestVersionOverride: '0.5.0'
      },
      {
        getCurrentVersion: () => '0.4.0',
        getInstallChannel: () => ({ kind: 'windows-msi' })
      }
    );

    expect(result.installChannel).toBe('windows-msi');
    expect(result.recommendedCommand).toBe(
      'winget upgrade --id Xyte.XyteCLI --exact --source winget --accept-source-agreements --accept-package-agreements --silent'
    );
  });

  it('detects install channel once when applying an upgrade', async () => {
    const getInstallChannel = vi.fn(() => ({
      kind: 'npm' as const
    }));
    const commandRunner = vi.fn(async (command: string) => {
      if (/^npm(?:\.cmd)?$/.test(command)) {
        return {
          code: 0,
          stdout: '',
          stderr: ''
        };
      }
      if (/^xyte-cli(?:\.cmd)?$/.test(command)) {
        return {
          code: 0,
          stdout: 'xyte-cli 0.5.0\n',
          stderr: ''
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    await applyUpgrade(
      {
        packageName: '@xyteai/cli',
        skillSourceDir: '/repo/skills/xyte-cli',
        latestVersionOverride: '0.5.0'
      },
      {
        fetchImpl: vi.fn() as any,
        commandRunner,
        getCurrentVersion: () => '0.4.0',
        getInstallChannel,
        installSkillsImpl: vi.fn().mockResolvedValue({
          workspaceRoot: '/tmp/workspace',
          homeRoot: '/tmp/home',
          sourceDir: '/repo/skills/xyte-cli',
          outcomes: [],
          createdRoots: []
        })
      }
    );

    expect(getInstallChannel).toHaveBeenCalledTimes(1);
  });

  it('applies upgrade using install spec and emits skill warning on partial failure', async () => {
    const commandRunner = vi.fn(async (command: string, args: string[]) => {
      if (/^npm(?:\.cmd)?$/.test(command)) {
        expect(args).toEqual(['install', '--global', '/artifacts/xyteai-cli-b.tgz']);
        return {
          code: 0,
          stdout: '',
          stderr: ''
        };
      }
      if (/^xyte-cli(?:\.cmd)?$/.test(command)) {
        return {
          code: 0,
          stdout: 'xyte-cli 0.5.0\n',
          stderr: ''
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await applyUpgrade(
      {
        packageName: '@xyteai/cli',
        skillSourceDir: '/repo/skills/xyte-cli',
        installSpec: '/artifacts/xyteai-cli-b.tgz',
        latestVersionOverride: '0.5.0'
      },
      {
        fetchImpl: vi.fn() as any,
        commandRunner,
        getCurrentVersion: () => '0.4.0',
        getInstallChannel: () => ({ kind: 'npm' }),
        installSkillsImpl: vi.fn().mockResolvedValue({
          workspaceRoot: '/tmp/workspace',
          homeRoot: '/tmp/home',
          sourceDir: '/repo/skills/xyte-cli',
          outcomes: [
            {
              scope: 'user',
              agent: 'codex',
              rootDir: '/tmp/home/.agents/skills',
              targetDir: '/tmp/home/.agents/skills/xyte-cli',
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
        })
      }
    );

    expect(result.updated).toBe(true);
    expect(result.installChannel).toBe('npm');
    expect(result.verify?.match).toBe(true);
    expect(result.skills?.scope).toBe('user');
    expect(result.skills?.failedCount).toBe(1);
    expect(result.warnings.length).toBe(1);
  });

  it('uses target version override as install spec when installSpec is unset', async () => {
    const commandRunner = vi.fn(async (command: string, args: string[]) => {
      if (/^npm(?:\.cmd)?$/.test(command)) {
        expect(args).toEqual(['install', '--global', '@xyteai/cli@0.6.0']);
        return {
          code: 0,
          stdout: '',
          stderr: ''
        };
      }
      if (/^xyte-cli(?:\.cmd)?$/.test(command)) {
        return {
          code: 0,
          stdout: 'xyte-cli 0.6.0\n',
          stderr: ''
        };
      }
      throw new Error(`Unexpected command: ${command}`);
    });

    const result = await applyUpgrade(
      {
        packageName: '@xyteai/cli',
        skillSourceDir: '/repo/skills/xyte-cli',
        latestVersionOverride: '0.6.0'
      },
      {
        fetchImpl: vi.fn() as any,
        commandRunner,
        getCurrentVersion: () => '0.5.0',
        getInstallChannel: () => ({ kind: 'npm' }),
        installSkillsImpl: vi.fn().mockResolvedValue({
          workspaceRoot: '/tmp/workspace',
          homeRoot: '/tmp/home',
          sourceDir: '/repo/skills/xyte-cli',
          outcomes: [],
          createdRoots: []
        })
      }
    );

    expect(result.updated).toBe(true);
    expect(result.updateCommand?.args).toEqual(['install', '--global', '@xyteai/cli@0.6.0']);
  });

  const msiChannel = () => ({ kind: 'windows-msi' as const });
  const wingetFlags = ['--source', 'winget', '--accept-source-agreements', '--accept-package-agreements', '--silent'];

  it('hands Windows MSI upgrades off to a winget console window without verifying or refreshing skills', async () => {
    const commandRunner = vi.fn();
    const detachedLauncher = vi.fn().mockResolvedValue(undefined);
    const installSkillsImpl = vi.fn();

    const result = await applyUpgrade(
      { packageName: '@xyteai/cli', skillSourceDir: '/repo/skills/xyte-cli', launchInteractive: true },
      {
        fetchImpl: vi.fn().mockResolvedValue({ ok: true, json: async () => ({ version: '0.7.0' }) }) as any,
        commandRunner,
        detachedLauncher,
        getCurrentVersion: () => '0.6.0',
        getInstallChannel: msiChannel,
        installSkillsImpl
      }
    );

    const expectedArgs = ['upgrade', '--id', 'Xyte.XyteCLI', '--exact', ...wingetFlags];
    expect(detachedLauncher).toHaveBeenCalledWith('winget', expectedArgs);
    expect(commandRunner).not.toHaveBeenCalled();
    expect(installSkillsImpl).not.toHaveBeenCalled();
    expect(result.installChannel).toBe('windows-msi');
    expect(result.updated).toBe(false);
    expect(result.handoff).toEqual({ tool: 'winget', status: 'started' });
    expect(result.updateCommand).toEqual({ command: 'winget', args: expectedArgs });
    expect(result.verify).toBeUndefined();
    expect(result.skills).toBeUndefined();
  });

  it('pins the winget version when a target version override is set', async () => {
    const detachedLauncher = vi.fn().mockResolvedValue(undefined);

    await applyUpgrade(
      { packageName: '@xyteai/cli', skillSourceDir: '/repo/skills/xyte-cli', latestVersionOverride: '0.7.0', launchInteractive: true },
      {
        fetchImpl: vi.fn() as any,
        commandRunner: vi.fn(),
        detachedLauncher,
        getCurrentVersion: () => '0.6.0',
        getInstallChannel: msiChannel,
        installSkillsImpl: vi.fn()
      }
    );

    expect(detachedLauncher).toHaveBeenCalledWith('winget', [
      'upgrade',
      '--id',
      'Xyte.XyteCLI',
      '--exact',
      '--version',
      '0.7.0',
      ...wingetFlags
    ]);
  });

  it('rejects an npm install spec on the windows-msi channel', async () => {
    const detachedLauncher = vi.fn();

    await expect(
      applyUpgrade(
        { packageName: '@xyteai/cli', skillSourceDir: '/repo/skills/xyte-cli', installSpec: '@xyteai/cli@0.7.0' },
        { fetchImpl: vi.fn() as any, detachedLauncher, getCurrentVersion: () => '0.6.0', getInstallChannel: msiChannel }
      )
    ).rejects.toThrow(/XYTE_CLI_UPGRADE_SPEC is not supported on the windows-msi install channel/);
    expect(detachedLauncher).not.toHaveBeenCalled();
  });

  it('reports a clear error when winget cannot be started', async () => {
    await expect(
      applyUpgrade(
        { packageName: '@xyteai/cli', skillSourceDir: '/repo/skills/xyte-cli', latestVersionOverride: '0.7.0', launchInteractive: true },
        {
          fetchImpl: vi.fn() as any,
          detachedLauncher: vi.fn().mockRejectedValue(new Error('spawn winget ENOENT')),
          getCurrentVersion: () => '0.6.0',
          getInstallChannel: msiChannel
        }
      )
    ).rejects.toThrow(/Could not start "winget": spawn winget ENOENT/);
  });

  it('returns the winget command without launching when there is no interactive terminal', async () => {
    const detachedLauncher = vi.fn();
    const commandRunner = vi.fn();

    const result = await applyUpgrade(
      { packageName: '@xyteai/cli', skillSourceDir: '/repo/skills/xyte-cli', latestVersionOverride: '0.7.0' },
      { fetchImpl: vi.fn() as any, commandRunner, detachedLauncher, getCurrentVersion: () => '0.6.0', getInstallChannel: msiChannel }
    );

    expect(detachedLauncher).not.toHaveBeenCalled();
    expect(commandRunner).not.toHaveBeenCalled();
    expect(result.handoff).toEqual({ tool: 'winget', status: 'manual' });
    expect(result.updateCommand?.args).toContain('0.7.0');
    expect(result.updated).toBe(false);
  });

  it('returns early without verify or skills refresh when an MSI install is already current', async () => {
    const detachedLauncher = vi.fn();
    const commandRunner = vi.fn();
    const installSkillsImpl = vi.fn();

    const result = await applyUpgrade(
      { packageName: '@xyteai/cli', skillSourceDir: '/repo/skills/xyte-cli', latestVersionOverride: '0.6.0', launchInteractive: true },
      { fetchImpl: vi.fn() as any, commandRunner, detachedLauncher, installSkillsImpl, getCurrentVersion: () => '0.6.0', getInstallChannel: msiChannel }
    );

    expect(detachedLauncher).not.toHaveBeenCalled();
    expect(commandRunner).not.toHaveBeenCalled();
    expect(installSkillsImpl).not.toHaveBeenCalled();
    expect(result.updated).toBe(false);
    expect(result.upToDateBefore).toBe(true);
    expect(result.handoff).toBeUndefined();
    expect(result.updateCommand).toBeUndefined();
    expect(result.verify).toBeUndefined();
    expect(result.skills).toBeUndefined();
  });

  it('rejects a non-semver target version on the windows-msi channel', async () => {
    const detachedLauncher = vi.fn();

    await expect(
      applyUpgrade(
        { packageName: '@xyteai/cli', skillSourceDir: '/repo/skills/xyte-cli', latestVersionOverride: '1.0.0 & calc', launchInteractive: true },
        { fetchImpl: vi.fn() as any, detachedLauncher, getCurrentVersion: () => '0.6.0', getInstallChannel: msiChannel }
      )
    ).rejects.toThrow(/is not a valid version/);
    expect(detachedLauncher).not.toHaveBeenCalled();
  });

  it('rejects a prerelease target version on the windows-msi channel', async () => {
    const detachedLauncher = vi.fn();

    await expect(
      applyUpgrade(
        { packageName: '@xyteai/cli', skillSourceDir: '/repo/skills/xyte-cli', latestVersionOverride: '1.0.0-rc.1', launchInteractive: true },
        { fetchImpl: vi.fn() as any, detachedLauncher, getCurrentVersion: () => '0.6.0', getInstallChannel: msiChannel }
      )
    ).rejects.toThrow(/prereleases have no MSI/);
    expect(detachedLauncher).not.toHaveBeenCalled();
  });

  it('resolves winget from WindowsApps first, never from the current directory or relative PATH entries', () => {
    const localApp = 'C:\\Users\\u\\AppData\\Local';
    const alias = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe';
    expect(resolveWingetPath({ LOCALAPPDATA: localApp, PATH: 'C:\\Tools' }, (p) => p === alias || p === 'C:\\Tools\\winget.exe', 'C:\\repo')).toBe(alias);

    const exists = (p: string) => ['C:\\repo\\winget.exe', 'bin\\winget.exe', 'C:\\Tools\\winget.exe'].includes(p);
    expect(resolveWingetPath({ PATH: 'C:\\repo;bin;.;C:\\Tools' }, exists, 'C:\\repo')).toBe('C:\\Tools\\winget.exe');

    expect(() => resolveWingetPath({ PATH: 'C:\\repo;.' }, () => true, 'C:\\repo')).toThrow(/winget.exe was not found/);
    expect(() => resolveWingetPath({ PATH: 'C:\\a&b' }, () => true, 'C:\\repo')).toThrow(/cannot be passed safely/);
  });

  it('builds a cmd.exe launch that opens a console window and keeps it open', () => {
    expect(buildWingetConsoleArgs('C:\\Windows\\System32\\cmd.exe', 'C:\\W\\winget.exe', ['upgrade', '--id', 'Xyte.XyteCLI'])).toEqual([
      '/d',
      '/c',
      'start',
      '"Xyte CLI upgrade"',
      '"C:\\Windows\\System32\\cmd.exe"',
      '/d',
      '/k',
      '"C:\\W\\winget.exe"',
      'upgrade',
      '--id',
      'Xyte.XyteCLI'
    ]);
  });

  it('resolves cmd.exe to an absolute path, never by bare name', () => {
    expect(resolveCmdPath({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' })).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(resolveCmdPath({ ComSpec: 'cmd.exe', SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\cmd.exe');
    expect(resolveCmdPath({})).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(() => resolveCmdPath({ SystemRoot: 'Win' })).toThrow(/not absolute/);
    expect(() => resolveCmdPath({ ComSpec: 'C:\\a&b\\cmd.exe' })).toThrow(/cannot be passed safely/);
  });

  it('prints a passive update notice at most once per check interval', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-update-notifier-'));
    const env = {
      XYTE_CLI_CONFIG_DIR: configDir,
      NODE_ENV: 'development'
    };
    const stderr = { write: vi.fn() };
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ version: '0.12.3' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );

    const first = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env,
      stderr,
      isInteractive: true,
      stdoutIsTTY: true,
      now: () => new Date('2026-07-07T08:00:00.000Z'),
      upgradeDependencies: {
        fetchImpl,
        getCurrentVersion: () => '0.12.0'
      }
    });

    expect(first.notified).toBe(true);
    expect(stderr.write).toHaveBeenCalledWith(
      'A new version of xyte-cli is available: 0.12.0 -> 0.12.3\nTo upgrade, run: xyte-cli upgrade\n'
    );

    const second = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env,
      stderr,
      isInteractive: true,
      stdoutIsTTY: true,
      now: () => new Date('2026-07-07T09:00:00.000Z'),
      upgradeDependencies: {
        fetchImpl,
        getCurrentVersion: () => '0.12.0'
      }
    });

    expect(second.notified).toBe(false);
    expect(second.reason).toBe('recently-checked');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const cache = JSON.parse(readFileSync(join(configDir, 'update-notifier.json'), 'utf8')) as {
      checkedAtUtc: string;
      checkFailed?: boolean;
    };
    expect(cache.checkedAtUtc).toBe('2026-07-07T08:00:00.000Z');
    expect(cache.checkFailed).toBeUndefined();

    // After the interval elapses, the same available version notifies again.
    const third = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env,
      stderr,
      isInteractive: true,
      stdoutIsTTY: true,
      now: () => new Date('2026-07-08T08:00:00.000Z'),
      upgradeDependencies: {
        fetchImpl,
        getCurrentVersion: () => '0.12.0'
      }
    });

    expect(third.notified).toBe(true);
    expect(third.reason).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(stderr.write).toHaveBeenCalledTimes(2);
  });

  it('suppresses update notices for machine-readable command output', async () => {
    const fetchImpl = vi.fn();
    const result = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env: { NODE_ENV: 'development' },
      stderr: { write: vi.fn() },
      isInteractive: true,
      stdoutIsTTY: true,
      commandOutputIsMachineReadable: true,
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });

    expect(result).toMatchObject({ notified: false, checked: false, reason: 'machine-output' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('suppresses update notices for configured json output or strict json', async () => {
    const fetchImpl = vi.fn();
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-notifier-configured-'));
    const env = { XYTE_CLI_CONFIG_DIR: configDir, NODE_ENV: 'development' };

    const configuredJson = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env,
      stderr: { write: vi.fn() },
      isInteractive: true,
      stdoutIsTTY: true,
      resolveOutputConfig: async () => ({ outputMode: 'json', strictJson: false }),
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });
    expect(configuredJson.reason).toBe('configured-json');

    const strict = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env,
      stderr: { write: vi.fn() },
      isInteractive: true,
      stdoutIsTTY: true,
      resolveOutputConfig: async () => ({ outputMode: 'auto', strictJson: true }),
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });
    expect(strict.reason).toBe('configured-json');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips only for truthy XYTE_CLI_NO_UPDATE_NOTIFIER values', async () => {
    const fetchImpl = vi.fn();
    const optOut = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env: { XYTE_CLI_NO_UPDATE_NOTIFIER: '1', NODE_ENV: 'development' },
      stderr: { write: vi.fn() },
      isInteractive: true,
      stdoutIsTTY: true,
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });
    expect(optOut).toMatchObject({ notified: false, checked: false, reason: 'opt-out' });

    // A falsy value does not opt out; the run proceeds to the next skip rule.
    const falsyValue = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env: { XYTE_CLI_NO_UPDATE_NOTIFIER: '0', CI: 'true', NODE_ENV: 'development' },
      stderr: { write: vi.fn() },
      isInteractive: true,
      stdoutIsTTY: true,
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });
    expect(falsyValue.reason).toBe('ci');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips in CI environments without resolving output settings', async () => {
    const fetchImpl = vi.fn();
    const resolveOutputConfig = vi.fn();
    const result = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env: { CI: 'true', NODE_ENV: 'development' },
      stderr: { write: vi.fn() },
      isInteractive: true,
      stdoutIsTTY: true,
      resolveOutputConfig,
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });
    expect(result).toMatchObject({ notified: false, checked: false, reason: 'ci' });
    expect(resolveOutputConfig).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips for non-interactive or non-TTY', async () => {
    const fetchImpl = vi.fn();
    const nonInteractive = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env: { NODE_ENV: 'development' },
      stderr: { write: vi.fn() },
      isInteractive: false,
      stdoutIsTTY: true,
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });
    expect(nonInteractive.reason).toBe('non-interactive');

    const noTty = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env: { NODE_ENV: 'development' },
      stderr: { write: vi.fn() },
      isInteractive: true,
      stdoutIsTTY: false,
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });
    expect(noTty.reason).toBe('non-interactive');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips for the upgrade command itself', async () => {
    const fetchImpl = vi.fn();
    const result = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli upgrade',
      env: { NODE_ENV: 'development' },
      stderr: { write: vi.fn() },
      isInteractive: true,
      stdoutIsTTY: true,
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });
    expect(result).toMatchObject({ notified: false, checked: false, reason: 'upgrade-command' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns up-to-date when latest matches current', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-notifier-uptodate-'));
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ version: '0.12.0' }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const result = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env: { XYTE_CLI_CONFIG_DIR: configDir, NODE_ENV: 'development' },
      stderr: { write: vi.fn() },
      isInteractive: true,
      stdoutIsTTY: true,
      now: () => new Date('2026-07-07T08:00:00.000Z'),
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });
    expect(result).toMatchObject({ notified: false, checked: true, reason: 'up-to-date' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a failed registry check after the shorter failure interval', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-notifier-fail-'));
    const env = { XYTE_CLI_CONFIG_DIR: configDir, NODE_ENV: 'development' };
    const fetchImpl = vi.fn().mockRejectedValue(new Error('network down'));
    const stderr = { write: vi.fn() };

    const failed = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env,
      stderr,
      isInteractive: true,
      stdoutIsTTY: true,
      now: () => new Date('2026-07-07T08:00:00.000Z'),
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });

    expect(failed).toMatchObject({ notified: false, checked: true, reason: 'check-failed' });
    expect(stderr.write).not.toHaveBeenCalled();
    const cache = JSON.parse(readFileSync(join(configDir, 'update-notifier.json'), 'utf8')) as {
      checkedAtUtc?: string;
      checkFailed?: boolean;
    };
    expect(cache.checkedAtUtc).toBe('2026-07-07T08:00:00.000Z');
    expect(cache.checkFailed).toBe(true);

    // Within the failure retry window nothing fetches.
    const shortlyAfter = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env,
      stderr,
      isInteractive: true,
      stdoutIsTTY: true,
      now: () => new Date('2026-07-07T08:30:00.000Z'),
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });
    expect(shortlyAfter.reason).toBe('recently-checked');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // After the failure retry interval a new check runs without waiting 24h.
    fetchImpl.mockResolvedValue(
      new Response(JSON.stringify({ version: '0.12.3' }), { status: 200, headers: { 'content-type': 'application/json' } })
    );
    const retried = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env,
      stderr,
      isInteractive: true,
      stdoutIsTTY: true,
      now: () => new Date('2026-07-07T10:00:00.000Z'),
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });
    expect(retried.notified).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a future-dated cache timestamp as stale', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-notifier-future-'));
    writeFileSync(
      join(configDir, 'update-notifier.json'),
      `${JSON.stringify({ version: 1, checkedAtUtc: '2027-01-01T00:00:00.000Z' })}\n`,
      'utf8'
    );
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ version: '0.12.0' }), { status: 200, headers: { 'content-type': 'application/json' } })
    );

    const result = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env: { XYTE_CLI_CONFIG_DIR: configDir, NODE_ENV: 'development' },
      stderr: { write: vi.fn() },
      isInteractive: true,
      stdoutIsTTY: true,
      now: () => new Date('2026-07-07T08:00:00.000Z'),
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });

    expect(result).toMatchObject({ notified: false, checked: true, reason: 'up-to-date' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('bails out without fetching when the cache is unwritable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-notifier-unwritable-'));
    const notADir = join(dir, 'config-path');
    writeFileSync(notADir, 'not a directory', 'utf8');
    const fetchImpl = vi.fn();

    const result = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env: { XYTE_CLI_CONFIG_DIR: notADir, NODE_ENV: 'development' },
      stderr: { write: vi.fn() },
      isInteractive: true,
      stdoutIsTTY: true,
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });

    expect(result).toMatchObject({ notified: false, checked: false, reason: 'cache-unwritable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('times out when registry response body stalls', async () => {
    vi.useFakeTimers();
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-notifier-timeout-'));
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          json: () => new Promise(() => undefined)
        }) as unknown as Response
    ) as unknown as typeof fetch;

    try {
      const resultPromise = maybeNotifyUpdateAvailable({
        commandPath: 'xyte-cli status',
        env: { XYTE_CLI_CONFIG_DIR: configDir, NODE_ENV: 'development' },
        stderr: { write: vi.fn() },
        isInteractive: true,
        stdoutIsTTY: true,
        fetchTimeoutMs: 20,
        upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
      });
      await vi.advanceTimersByTimeAsync(21);
      const result = await resultPromise;

      expect(result).toMatchObject({ notified: false, checked: true, reason: 'check-failed' });
    } finally {
      vi.useRealTimers();
    }
  });
});
