import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

const scriptPath = pathToFileURL(resolve(__dirname, '../scripts/smoke_external_user_live.mjs')).href;

describe('external live smoke script', () => {
  it('fails fast when XYTE_CLI_KEY is missing', async () => {
    const mod = await import(/* @vite-ignore */ scriptPath);
    expect(() => mod.resolveSmokeInputs({})).toThrow(/Missing XYTE_CLI_KEY/);
  });

  it('runs expected command sequence with provided env', async () => {
    const mod = await import(/* @vite-ignore */ scriptPath);
    const calls: Array<{ command: string; args: string[] }> = [];

    const run = vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args });

      if (command.includes('npm') && args[0] === 'pack') {
        return { code: 0, stdout: '[{"filename":"xyte-cli-0.1.0.tgz"}]', stderr: '' };
      }
      if (command.includes('npm') && args[0] === 'install') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if ((command.includes('node') || command.includes('node.exe')) && args[0] === '-e') {
        return { code: 0, stdout: 'Skill manifests are present and actionable for xyte-cli automation.', stderr: '' };
      }
      if (args[0] === 'status') {
        return { code: 0, stdout: '{"schemaVersion":"xyte.status.v1","mode":"fast","readiness":{"state":"missing"}}', stderr: '' };
      }
      if (args[0] === 'setup' && args[1] === 'run') {
        return { code: 0, stdout: '{}', stderr: '' };
      }
      if (args[0] === 'setup' && args[1] === 'status') {
        return { code: 0, stdout: '{"state":"ready"}', stderr: '' };
      }
      if (args[0] === 'init') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'api' && args[1] === 'call') {
        return { code: 0, stdout: '{"schemaVersion":"xyte.call.envelope.v1","response":{"status":200}}', stderr: '' };
      }

      return { code: 0, stdout: '', stderr: '' };
    });

    const rmFn = vi.fn(async () => undefined);
    const unlinkFn = vi.fn(async () => undefined);
    const pathExistsFn = vi.fn(async () => true);

    await mod.runExternalUserLiveSmoke({
      cwd: '/work/xyte-cli',
      env: {
        XYTE_CLI_KEY: 'real-key',
        XYTE_E2E_TENANT: 'acme',
        PATH: '/usr/bin'
      },
      run,
      logger: { log: vi.fn() },
      mkdtempFn: vi.fn(async () => '/tmp/xyte-smoke-test'),
      mkdirFn: vi.fn(async () => undefined),
      rmFn,
      unlinkFn,
      pathExistsFn
    });

    expect(calls.map((item) => item.args.join(' '))).toHaveLength(8);
    expect(calls[0].args.join(' ')).toBe('pack --json');
    expect(calls[1].args.join(' ')).toBe('install --global /work/xyte-cli/xyte-cli-0.1.0.tgz');
    expect(calls[2].args.join(' ')).toBe('status --mode fast --output json');
    expect(calls[3].args.join(' ')).toBe(
      'init --scope both --agents all --target /tmp/xyte-smoke-test/workspace --force --no-setup'
    );
    expect(calls[4].command).toMatch(/node(\.exe)?/);
    expect(calls[4].args[0]).toBe('-e');
    expect(calls[5].args.join(' ')).toBe('setup run --non-interactive --tenant acme --key real-key');
    expect(calls[6].args.join(' ')).toBe('setup status --tenant acme --output json');
    expect(calls[7].args.join(' ')).toBe('api call organization.devices.getDevices --tenant acme --output-mode envelope --strict-json');
    expect(pathExistsFn).toHaveBeenCalled();
    expect(rmFn).toHaveBeenCalledWith('/tmp/xyte-smoke-test', { recursive: true, force: true });
    expect(unlinkFn).toHaveBeenCalledWith('/work/xyte-cli/xyte-cli-0.1.0.tgz');
  });

  it('stops on first command failure and does cleanup', async () => {
    const mod = await import(/* @vite-ignore */ scriptPath);
    const calls: Array<{ command: string; args: string[] }> = [];

    const run = vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args });

      if (command.includes('npm') && args[0] === 'pack') {
        return { code: 0, stdout: '[{"filename":"xyte-cli-0.1.0.tgz"}]', stderr: '' };
      }
      if (command.includes('npm') && args[0] === 'install') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'status') {
        return { code: 1, stdout: '', stderr: 'wiring failed' };
      }

      return { code: 0, stdout: '', stderr: '' };
    });

    const rmFn = vi.fn(async () => undefined);
    const unlinkFn = vi.fn(async () => undefined);
    const pathExistsFn = vi.fn(async () => true);

    await expect(
      mod.runExternalUserLiveSmoke({
        cwd: '/work/xyte-cli',
        env: {
          XYTE_CLI_KEY: 'real-key',
          XYTE_E2E_TENANT: 'acme',
          PATH: '/usr/bin'
        },
        run,
        logger: { log: vi.fn() },
        mkdtempFn: vi.fn(async () => '/tmp/xyte-smoke-fail'),
        mkdirFn: vi.fn(async () => undefined),
        rmFn,
        unlinkFn,
        pathExistsFn
      })
    ).rejects.toThrow(/xyte-cli status/);

    expect(calls.map((item) => item.args.join(' '))).toEqual([
      'pack --json',
      'install --global /work/xyte-cli/xyte-cli-0.1.0.tgz',
      'status --mode fast --output json'
    ]);
    expect(rmFn).toHaveBeenCalledWith('/tmp/xyte-smoke-fail', { recursive: true, force: true });
    expect(unlinkFn).toHaveBeenCalledWith('/work/xyte-cli/xyte-cli-0.1.0.tgz');
  });

  it('fails when skills were not copied to expected locations', async () => {
    const mod = await import(/* @vite-ignore */ scriptPath);

    const run = vi.fn(async (command: string, args: string[]) => {
      if (command.includes('npm') && args[0] === 'pack') {
        return { code: 0, stdout: '[{"filename":"xyte-cli-0.1.0.tgz"}]', stderr: '' };
      }
      if (command.includes('npm') && args[0] === 'install') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === 'status') {
        return { code: 0, stdout: '{"schemaVersion":"xyte.status.v1","mode":"fast","readiness":{"state":"missing"}}', stderr: '' };
      }
      if (args[0] === 'install') {
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '{}', stderr: '' };
    });

    const rmFn = vi.fn(async () => undefined);
    const unlinkFn = vi.fn(async () => undefined);

    await expect(
      mod.runExternalUserLiveSmoke({
        cwd: '/work/xyte-cli',
        env: {
          XYTE_CLI_KEY: 'real-key',
          PATH: '/usr/bin'
        },
        run,
        logger: { log: vi.fn() },
        mkdtempFn: vi.fn(async () => '/tmp/xyte-smoke-skill-miss'),
        mkdirFn: vi.fn(async () => undefined),
        rmFn,
        unlinkFn,
        pathExistsFn: vi.fn(async () => false)
      })
    ).rejects.toThrow(/Skills install verification failed/);

    expect(rmFn).toHaveBeenCalledWith('/tmp/xyte-smoke-skill-miss', { recursive: true, force: true });
    expect(unlinkFn).toHaveBeenCalledWith('/work/xyte-cli/xyte-cli-0.1.0.tgz');
  });
});
