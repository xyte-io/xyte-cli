import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { installSkills, resolveSkillInstallDestinations } from '../src/utils/install-skills';

describe('install skills', () => {
  it('resolves project destinations with deterministic path mapping', () => {
    const workspace = '/workspace';
    const home = '/home/user';

    const destinations = resolveSkillInstallDestinations({
      skillName: 'xyte-cli',
      scope: 'project',
      agents: ['claude', 'copilot', 'codex'],
      workspaceRoot: workspace,
      homeRoot: home
    });

    expect(destinations).toEqual([
      {
        scope: 'project',
        agent: 'claude',
        rootDir: join(workspace, '.claude', 'skills'),
        targetDir: join(workspace, '.claude', 'skills', 'xyte-cli')
      },
      {
        scope: 'project',
        agent: 'copilot',
        rootDir: join(workspace, '.github', 'skills'),
        targetDir: join(workspace, '.github', 'skills', 'xyte-cli')
      },
      {
        scope: 'project',
        agent: 'codex',
        rootDir: join(workspace, '.agents', 'skills'),
        targetDir: join(workspace, '.agents', 'skills', 'xyte-cli')
      }
    ]);
  });

  it('resolves both scopes in project-first order', () => {
    const destinations = resolveSkillInstallDestinations({
      skillName: 'xyte-cli',
      scope: 'both',
      agents: ['claude', 'copilot', 'codex'],
      workspaceRoot: '/workspace',
      homeRoot: '/home/user'
    });

    expect(destinations.map((item) => `${item.scope}/${item.agent}`)).toEqual([
      'project/claude',
      'project/copilot',
      'project/codex',
      'user/claude',
      'user/copilot',
      'user/codex'
    ]);
  });

  it('installs all selected destinations and records statuses', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'xyte-cli-workspace-'));
    const home = mkdtempSync(join(tmpdir(), 'xyte-cli-home-'));
    const source = mkdtempSync(join(tmpdir(), 'xyte-cli-source-'));
    writeFileSync(join(source, 'SKILL.md'), '# Skill', 'utf8');

    const result = await installSkills({
      skillName: 'xyte-cli',
      sourceDir: source,
      scope: 'project',
      agents: ['claude', 'copilot', 'codex'],
      targetWorkspace: workspace,
      homeDir: home
    });

    expect(result.outcomes.map((item) => item.status)).toEqual(['installed', 'installed', 'installed']);
    expect(existsSync(join(workspace, '.claude', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(workspace, '.github', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(workspace, '.agents', 'skills', 'xyte-cli', 'SKILL.md'))).toBe(true);
  });

  it('skips existing destination without force and overwrites with force', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'xyte-cli-workspace-'));
    const home = mkdtempSync(join(tmpdir(), 'xyte-cli-home-'));
    const source = mkdtempSync(join(tmpdir(), 'xyte-cli-source-'));
    writeFileSync(join(source, 'SKILL.md'), '# Skill', 'utf8');

    await installSkills({
      skillName: 'xyte-cli',
      sourceDir: source,
      scope: 'project',
      agents: ['claude'],
      targetWorkspace: workspace,
      homeDir: home
    });

    const skipped = await installSkills({
      skillName: 'xyte-cli',
      sourceDir: source,
      scope: 'project',
      agents: ['claude'],
      targetWorkspace: workspace,
      homeDir: home
    });
    expect(skipped.outcomes.map((item) => item.status)).toEqual(['skipped']);

    const overwritten = await installSkills({
      skillName: 'xyte-cli',
      sourceDir: source,
      scope: 'project',
      agents: ['claude'],
      targetWorkspace: workspace,
      homeDir: home,
      force: true
    });
    expect(overwritten.outcomes.map((item) => item.status)).toEqual(['overwritten']);
  });

  it('reports partial failures while continuing other destinations', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'xyte-cli-workspace-'));
    const home = mkdtempSync(join(tmpdir(), 'xyte-cli-home-'));
    const source = mkdtempSync(join(tmpdir(), 'xyte-cli-source-'));
    writeFileSync(join(source, 'SKILL.md'), '# Skill', 'utf8');
    writeFileSync(join(workspace, '.github'), 'not-a-directory', 'utf8');

    const result = await installSkills({
      skillName: 'xyte-cli',
      sourceDir: source,
      scope: 'project',
      agents: ['claude', 'copilot', 'codex'],
      targetWorkspace: workspace,
      homeDir: home
    });

    const statusByAgent = new Map(result.outcomes.map((item) => [item.agent, item.status]));
    expect(statusByAgent.get('claude')).toBe('installed');
    expect(statusByAgent.get('copilot')).toBe('failed');
    expect(statusByAgent.get('codex')).toBe('installed');
  });
});
