import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { applyUpgrade, checkForUpgrade } from '../src/cli/upgrade';
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
        getCurrentVersion: () => '0.4.0'
      }
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.latestVersion).toBe('0.5.0');
    expect(result.upToDate).toBe(false);
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
    expect(result.verify.match).toBe(true);
    expect(result.skills.scope).toBe('user');
    expect(result.skills.failedCount).toBe(1);
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
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-notifier-timeout-'));
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          json: () => new Promise(() => undefined)
        }) as unknown as Response
    ) as unknown as typeof fetch;
    const startedAt = Date.now();

    const result = await maybeNotifyUpdateAvailable({
      commandPath: 'xyte-cli status',
      env: { XYTE_CLI_CONFIG_DIR: configDir, NODE_ENV: 'development' },
      stderr: { write: vi.fn() },
      isInteractive: true,
      stdoutIsTTY: true,
      fetchTimeoutMs: 20,
      upgradeDependencies: { fetchImpl, getCurrentVersion: () => '0.12.0' }
    });

    expect(result).toMatchObject({ notified: false, checked: true, reason: 'check-failed' });
    expect(Date.now() - startedAt).toBeLessThan(500);
  });
});
