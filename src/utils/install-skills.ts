import { access, constants, cp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type SkillAgent = 'claude' | 'copilot' | 'codex';
export type SkillInstallScope = 'project' | 'user' | 'both';
export type SkillInstallStatus = 'installed' | 'overwritten' | 'skipped' | 'failed';

export interface SkillInstallDestination {
  agent: SkillAgent;
  scope: 'project' | 'user';
  rootDir: string;
  targetDir: string;
}

export interface SkillInstallOutcome extends SkillInstallDestination {
  status: SkillInstallStatus;
  error?: string;
}

export interface InstallSkillsOptions {
  skillName: string;
  sourceDir: string;
  scope: SkillInstallScope;
  agents: SkillAgent[];
  targetWorkspace?: string;
  homeDir?: string;
  force?: boolean;
}

export interface InstallSkillsResult {
  workspaceRoot: string;
  homeRoot: string;
  sourceDir: string;
  outcomes: SkillInstallOutcome[];
  createdRoots: string[];
}

const AGENT_ORDER: SkillAgent[] = ['claude', 'copilot', 'codex'];

function rootForDestination(destination: { scope: 'project' | 'user'; agent: SkillAgent; workspaceRoot: string; homeRoot: string }) {
  if (destination.scope === 'project') {
    if (destination.agent === 'claude') {
      return path.join(destination.workspaceRoot, '.claude', 'skills');
    }
    if (destination.agent === 'copilot') {
      return path.join(destination.workspaceRoot, '.github', 'skills');
    }
    return path.join(destination.workspaceRoot, '.agents', 'skills');
  }

  if (destination.agent === 'claude') {
    return path.join(destination.homeRoot, '.claude', 'skills');
  }
  if (destination.agent === 'copilot') {
    return path.join(destination.homeRoot, '.copilot', 'skills');
  }
  return path.join(destination.homeRoot, '.agents', 'skills');
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveSkillInstallDestinations(options: {
  skillName: string;
  scope: SkillInstallScope;
  agents: SkillAgent[];
  workspaceRoot: string;
  homeRoot: string;
}): SkillInstallDestination[] {
  const selectedScopes: Array<'project' | 'user'> = options.scope === 'both' ? ['project', 'user'] : [options.scope];
  const selectedAgents = AGENT_ORDER.filter((agent) => options.agents.includes(agent));
  const destinations: SkillInstallDestination[] = [];

  for (const scope of selectedScopes) {
    for (const agent of selectedAgents) {
      const rootDir = rootForDestination({
        scope,
        agent,
        workspaceRoot: options.workspaceRoot,
        homeRoot: options.homeRoot
      });
      destinations.push({
        scope,
        agent,
        rootDir,
        targetDir: path.join(rootDir, options.skillName)
      });
    }
  }

  return destinations;
}

export async function installSkills(options: InstallSkillsOptions): Promise<InstallSkillsResult> {
  const workspaceRoot = path.resolve(options.targetWorkspace ?? process.cwd());
  const homeRoot = path.resolve(options.homeDir ?? homedir());
  const sourceDir = path.resolve(options.sourceDir);

  if (!(await pathExists(sourceDir))) {
    throw new Error(`Skill source does not exist: ${sourceDir}`);
  }

  const destinations = resolveSkillInstallDestinations({
    skillName: options.skillName,
    scope: options.scope,
    agents: options.agents,
    workspaceRoot,
    homeRoot
  });

  const outcomes: SkillInstallOutcome[] = [];
  const createdRoots = new Set<string>();

  for (const destination of destinations) {
    try {
      if (!(await pathExists(destination.rootDir))) {
        await mkdir(destination.rootDir, { recursive: true });
        createdRoots.add(destination.rootDir);
      }

      const alreadyInstalled = await pathExists(destination.targetDir);
      if (alreadyInstalled && options.force !== true) {
        outcomes.push({
          ...destination,
          status: 'skipped'
        });
        continue;
      }

      if (alreadyInstalled && options.force === true) {
        await rm(destination.targetDir, { recursive: true, force: true });
      }

      await cp(sourceDir, destination.targetDir, { recursive: true });
      outcomes.push({
        ...destination,
        status: alreadyInstalled ? 'overwritten' : 'installed'
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcomes.push({
        ...destination,
        status: 'failed',
        error: message
      });
    }
  }

  return {
    workspaceRoot,
    homeRoot,
    sourceDir,
    outcomes,
    createdRoots: [...createdRoots]
  };
}
