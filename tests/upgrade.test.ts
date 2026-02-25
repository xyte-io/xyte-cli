import { describe, expect, it, vi } from 'vitest';

import { applyUpgrade, checkForUpgrade, compareSemver } from '../src/utils/upgrade';

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
      if (command === 'npm') {
        expect(args).toEqual(['install', '--global', '/artifacts/xyteai-cli-b.tgz']);
        return {
          code: 0,
          stdout: '',
          stderr: ''
        };
      }
      if (command === 'xyte-cli') {
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
});
