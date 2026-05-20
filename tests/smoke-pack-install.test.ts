import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import * as smokePackInstall from './smoke/pack-install';

describe('pack install smoke script', () => {
  it('runs expected command sequence with provided env', async () => {
    const repoRoot = '/work/xyte-cli';
    const tempRoot = '/tmp/xyte-pack-install-test';
    const workspaceDir = path.join(tempRoot, 'workspace');
    const artifactsDir = path.join(workspaceDir, 'artifacts');
    const reportsDir = path.join(workspaceDir, 'reports');
    const tarballPath = path.resolve(repoRoot, 'xyte-cli-0.1.0.tgz');

    const calls: Array<{ command: string; args: string[]; cwd?: string; input?: string }> = [];
    const startMockServerFn = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:43123',
      close: vi.fn(async () => undefined)
    }));

    const run = vi.fn(async (command: string, args: string[], options?: { cwd?: string; input?: string }) => {
      calls.push({ command, args, cwd: options?.cwd, input: options?.input });

      if (command.includes('npm') && args[0] === 'pack') {
        return { code: 0, stdout: '[{"filename":"xyte-cli-0.1.0.tgz"}]', stderr: '' };
      }
      if (command.includes('npm') && args[0] === 'install') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === '--help') {
        return { code: 0, stdout: 'Usage: xyte-cli [options] [command]', stderr: '' };
      }
      if (args[0] === 'doctor' && args[1] === 'install') {
        return { code: 0, stdout: '{"status":"ok","sameTarget":true}', stderr: '' };
      }
      if (args[0] === 'status') {
        return {
          code: 0,
          stdout: '{"schemaVersion":"xyte.status.v1","mode":"fast","readiness":{"state":"missing"}}',
          stderr: ''
        };
      }
      if (args[0] === 'init') {
        return { code: 0, stdout: 'Skill install summary:\nsetup skipped', stderr: '' };
      }
      if (args[0] === 'util' && args[1] === 'prepare') {
        return {
          code: 0,
          stdout: '{"actionKey":"organization.connectors.prepareSetup","executionSupport":"prepare-only"}',
          stderr: ''
        };
      }
      if (args[0] === 'util' && args[1] === 'list-actions') {
        return {
          code: 0,
          stdout: '[{"actionKey":"organization.connectors.prepareSetup","executionSupport":"prepare-only"}]',
          stderr: ''
        };
      }
      if (args[0] === 'setup' && args[1] === 'run') {
        return {
          code: 0,
          stdout: '{"tenantId":"acme","readiness":{"tenantId":"acme","state":"ready"}}',
          stderr: ''
        };
      }
      if (args[0] === 'setup' && args[1] === 'status') {
        return { code: 0, stdout: 'acme\n', stderr: '' };
      }
      if (args[0] === 'config' && args[1] === 'tenant') {
        return { code: 0, stdout: '{"id":"acme"}', stderr: '' };
      }
      if (args[0] === 'ops' && args[1] === 'watch') {
        return { code: 0, stdout: '{"schemaVersion":"xyte.watch.frame.v1"}\n', stderr: '' };
      }
      if (args[0] === 'ops' && args[1] === 'inspect' && args[2] === 'fleet') {
        return { code: 0, stdout: '{"schemaVersion":"xyte.inspect.fleet.v1"}', stderr: '' };
      }
      if (args[0] === 'ops' && args[1] === 'inspect' && args[2] === 'deep-dive') {
        return { code: 0, stdout: '{"schemaVersion":"xyte.inspect.deep-dive.v1"}', stderr: '' };
      }
      if (args[0] === 'ops' && args[1] === 'report') {
        return { code: 0, stdout: '{"schemaVersion":"xyte.report.v1"}', stderr: '' };
      }

      return { code: 0, stdout: '', stderr: '' };
    });

    const mkdirFn = vi.fn(async () => undefined);
    const rmFn = vi.fn(async () => undefined);
    const unlinkFn = vi.fn(async () => undefined);
    const writeFileFn = vi.fn(async () => undefined);
    const pathExistsFn = vi.fn(async () => true);
    const readFileFn = vi.fn(async (targetPath: string) => {
      if (targetPath.endsWith('.ndjson')) {
        return '{"schemaVersion":"xyte.watch.frame.v1"}\n';
      }
      if (targetPath.endsWith('xyte-fleet.json')) {
        return '{"schemaVersion":"xyte.inspect.fleet.v1"}';
      }
      if (targetPath.endsWith('xyte-deep-dive.json')) {
        return '{"schemaVersion":"xyte.inspect.deep-dive.v1"}';
      }
      return '# report\n';
    });

    await smokePackInstall.runPackInstallSmoke({
      cwd: repoRoot,
      env: {
        PATH: '/usr/bin'
      },
      run,
      logger: { log: vi.fn() },
      mkdtempFn: vi.fn(async () => tempRoot),
      mkdirFn,
      rmFn,
      unlinkFn,
      writeFileFn,
      pathExistsFn,
      readFileFn,
      startMockServerFn
    });

    expect(calls).toHaveLength(15);
    expect(calls[0].args.join(' ')).toBe('pack --json');
    expect(calls[1].args.join(' ')).toBe(`install --global ${tarballPath}`);
    expect(calls[2].args.join(' ')).toBe('--help');
    expect(calls[3].args.join(' ')).toBe('doctor install --format json');
    expect(calls[4].args.join(' ')).toBe('status --mode fast --output json');
    expect(calls[5].args.join(' ')).toBe(`init --scope both --agents all --target ${workspaceDir} --force`);
    expect(calls[6].args.join(' ')).toBe(
      `util prepare --action organization.connectors.prepareSetup --input ${path.join(workspaceDir, 'connectors.csv')} --output-dir ${path.join(workspaceDir, 'prepared')} --force`
    );
    expect(calls[7].args.join(' ')).toBe(
      'util list-actions --format json --mode friendly --execution-support prepare-only'
    );
    expect(calls[8].args.join(' ')).toBe(
      'setup run --non-interactive --tenant acme --provider xyte-org --key-stdin --connectivity never --output json'
    );
    expect(calls[8].input).toBe('smoke-test-key\n');
    expect(calls[9].args.join(' ')).toBe('setup status --tenant acme --field tenantId');
    expect(calls[10].args.join(' ')).toBe(
      'config tenant add acme --name Acme Mock --hub-url http://127.0.0.1:43123 --entry-url http://127.0.0.1:43123'
    );
    expect(calls[11].args.join(' ')).toBe(
      `ops watch incidents --tenant acme --profile incidents-active --once --output json --strict-json --out ${path.join(artifactsDir, 'xyte-watch.incidents.ndjson')}`
    );
    expect(calls[12].args.join(' ')).toBe(
      `ops inspect fleet --tenant acme --output json --out ${path.join(artifactsDir, 'xyte-fleet.json')}`
    );
    expect(calls[13].args.join(' ')).toBe(
      `ops inspect deep-dive --tenant acme --window 24 --output json --out ${path.join(artifactsDir, 'xyte-deep-dive.json')}`
    );
    expect(calls[14].args.join(' ')).toBe(
      `ops report generate --tenant acme --input ${path.join(artifactsDir, 'xyte-deep-dive.json')} --out ${path.join(reportsDir, 'fleet-report.md')} --render markdown`
    );
    expect(calls.slice(2).every((call) => call.cwd === workspaceDir)).toBe(true);
    expect(writeFileFn).toHaveBeenCalledWith(
      path.join(workspaceDir, 'connectors.csv'),
      'platform,targetSpace,authorizationOwner\nZoom Rooms,Milan HQ,AV operations\n',
      'utf8'
    );
    expect(startMockServerFn).toHaveBeenCalledWith({
      cwd: repoRoot,
      env: expect.objectContaining({
        PATH: expect.any(String)
      }),
      authToken: 'smoke-test-key'
    });
    expect(pathExistsFn).toHaveBeenCalled();
    expect(rmFn).toHaveBeenCalledWith(tempRoot, { recursive: true, force: true });
    expect(unlinkFn).toHaveBeenCalledWith(tarballPath);
  });

  it('fails when install doctor reports the wrong target', async () => {
    const repoRoot = '/work/xyte-cli';
    const tarballPath = path.resolve(repoRoot, 'xyte-cli-0.1.0.tgz');

    const run = vi.fn(async (command: string, args: string[]) => {
      if (command.includes('npm') && args[0] === 'pack') {
        return { code: 0, stdout: '[{"filename":"xyte-cli-0.1.0.tgz"}]', stderr: '' };
      }
      if (command.includes('npm') && args[0] === 'install') {
        return { code: 0, stdout: '', stderr: '' };
      }
      if (args[0] === '--help') {
        return { code: 0, stdout: 'Usage: xyte-cli [options] [command]', stderr: '' };
      }
      if (args[0] === 'doctor' && args[1] === 'install') {
        return { code: 0, stdout: '{"status":"mismatch","sameTarget":false}', stderr: '' };
      }

      return { code: 0, stdout: '', stderr: '' };
    });

    const rmFn = vi.fn(async () => undefined);
    const unlinkFn = vi.fn(async () => undefined);

    await expect(
      smokePackInstall.runPackInstallSmoke({
        cwd: repoRoot,
        env: {
          PATH: '/usr/bin'
        },
        run,
        logger: { log: vi.fn() },
        mkdtempFn: vi.fn(async () => '/tmp/xyte-pack-install-fail'),
        mkdirFn: vi.fn(async () => undefined),
        rmFn,
        unlinkFn,
        pathExistsFn: vi.fn(async () => true)
      })
    ).rejects.toThrow(/Install doctor did not report the packaged binary as active/);

    expect(rmFn).toHaveBeenCalledWith('/tmp/xyte-pack-install-fail', { recursive: true, force: true });
    expect(unlinkFn).toHaveBeenCalledWith(tarballPath);
  });
});
