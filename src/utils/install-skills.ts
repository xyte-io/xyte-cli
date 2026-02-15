import { access, constants, cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

export interface InstallSkillsOptions {
  skillName: string;
  sourceDir: string;
  targetWorkspace?: string;
  force?: boolean;
}

export interface InstallSkillsResult {
  workspaceRoot: string;
  sourceDir: string;
  targetDir: string;
  createdWorkspaceMarkers: boolean;
}

export async function installSkills(options: InstallSkillsOptions): Promise<InstallSkillsResult> {
  const workspaceRoot = path.resolve(options.targetWorkspace ?? process.cwd());
  const sourceDir = path.resolve(options.sourceDir);
  const targetDir = path.join(workspaceRoot, '.claude', 'skills', options.skillName);
  const skillsRoot = path.join(workspaceRoot, '.claude', 'skills');

  let createdWorkspaceMarkers = false;
  try {
    await access(skillsRoot, constants.F_OK);
  } catch {
    createdWorkspaceMarkers = true;
  }

  await mkdir(skillsRoot, { recursive: true });

  let targetExists = false;
  try {
    await access(targetDir, constants.F_OK);
    targetExists = true;
  } catch {
    targetExists = false;
  }

  if (targetExists) {
    if (!options.force) {
      throw new Error(`Skill already exists at ${targetDir}. Re-run with --force to overwrite.`);
    }
    await rm(targetDir, { recursive: true, force: true });
  }

  await cp(sourceDir, targetDir, { recursive: true });

  return {
    workspaceRoot,
    sourceDir,
    targetDir,
    createdWorkspaceMarkers
  };
}
