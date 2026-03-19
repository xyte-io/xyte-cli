import { spawn } from 'node:child_process';

import type { SkillAgent, SkillInstallOutcome } from './install-skills';
import { installSkills } from './install-skills';
import { getCliVersion } from './version';
import { buildUpgradeCheck, type UpgradeCheckV1, type UpgradeResultV1 } from '../contracts/upgrade';
import { UPGRADE_RESULT_SCHEMA_VERSION } from '../contracts/versions';

const DEFAULT_CLI_PACKAGE = '@xyteai/cli';
const DEFAULT_SKILL_AGENTS: SkillAgent[] = ['claude', 'copilot', 'codex'];

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;

export interface UpgradeDependencies {
  fetchImpl?: typeof fetch;
  commandRunner?: CommandRunner;
  installSkillsImpl?: typeof installSkills;
  getCurrentVersion?: () => string;
  npmCommand?: string;
}

interface UpgradeSettings {
  packageName?: string;
  skillSourceDir: string;
  installSpec?: string;
  latestVersionOverride?: string;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseSemver(value: string): ParsedSemver | undefined {
  const match = value.trim().match(SEMVER_RE);
  if (!match) {
    return undefined;
  }
  const prerelease = match[4] ? match[4].split('.').filter(Boolean) : [];
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    prerelease
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  const maxLength = Math.max(a.length, b.length);
  for (let index = 0; index < maxLength; index += 1) {
    const aPart = a[index];
    const bPart = b[index];
    if (aPart === undefined) {
      return -1;
    }
    if (bPart === undefined) {
      return 1;
    }

    const aNumber = Number.parseInt(aPart, 10);
    const bNumber = Number.parseInt(bPart, 10);
    const aIsNumber = Number.isFinite(aNumber) && String(aNumber) === aPart;
    const bIsNumber = Number.isFinite(bNumber) && String(bNumber) === bPart;

    if (aIsNumber && bIsNumber) {
      if (aNumber !== bNumber) {
        return aNumber > bNumber ? 1 : -1;
      }
      continue;
    }

    if (aIsNumber && !bIsNumber) {
      return -1;
    }
    if (!aIsNumber && bIsNumber) {
      return 1;
    }

    if (aPart !== bPart) {
      return aPart > bPart ? 1 : -1;
    }
  }
  return 0;
}

export function compareSemver(a: string, b: string): number {
  const aParsed = parseSemver(a);
  const bParsed = parseSemver(b);
  if (!aParsed || !bParsed) {
    return a === b ? 0 : a > b ? 1 : -1;
  }

  if (aParsed.major !== bParsed.major) {
    return aParsed.major > bParsed.major ? 1 : -1;
  }
  if (aParsed.minor !== bParsed.minor) {
    return aParsed.minor > bParsed.minor ? 1 : -1;
  }
  if (aParsed.patch !== bParsed.patch) {
    return aParsed.patch > bParsed.patch ? 1 : -1;
  }

  if (aParsed.prerelease.length === 0 && bParsed.prerelease.length === 0) {
    return 0;
  }
  if (aParsed.prerelease.length === 0) {
    return 1;
  }
  if (bParsed.prerelease.length === 0) {
    return -1;
  }
  return comparePrerelease(aParsed.prerelease, bParsed.prerelease);
}

function defaultRunner(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(command),
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function parseVersionFromOutput(output: string): string | undefined {
  const match = output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match ? match[0] : undefined;
}

async function fetchLatestVersion(packageName: string, fetchImpl: typeof fetch): Promise<string> {
  const encodedName = encodeURIComponent(packageName);
  const response = await fetchImpl(`https://registry.npmjs.org/${encodedName}/latest`, {
    headers: {
      accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch latest version for ${packageName} (HTTP ${response.status}).`);
  }

  const payload = (await response.json()) as { version?: unknown };
  if (typeof payload.version !== 'string' || !payload.version.trim()) {
    throw new Error(`Latest version response for ${packageName} is missing a valid version.`);
  }

  return payload.version;
}

export async function checkForUpgrade(
  settings: Pick<UpgradeSettings, 'packageName' | 'latestVersionOverride'> = {},
  deps: UpgradeDependencies = {}
): Promise<UpgradeCheckV1> {
  const packageName = settings.packageName ?? DEFAULT_CLI_PACKAGE;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const currentVersion = (deps.getCurrentVersion ?? getCliVersion)();
  const latestVersion =
    typeof settings.latestVersionOverride === 'string' && settings.latestVersionOverride.trim()
      ? settings.latestVersionOverride.trim()
      : await fetchLatestVersion(packageName, fetchImpl);
  return buildUpgradeCheck({
    packageName,
    currentVersion,
    latestVersion
  });
}

export async function applyUpgrade(settings: UpgradeSettings, deps: UpgradeDependencies = {}): Promise<UpgradeResultV1> {
  const packageName = settings.packageName ?? DEFAULT_CLI_PACKAGE;
  const runner = deps.commandRunner ?? defaultRunner;
  const installSkillsImpl = deps.installSkillsImpl ?? installSkills;
  const npmCommand = deps.npmCommand ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const check = await checkForUpgrade(
    {
      packageName,
      latestVersionOverride: settings.latestVersionOverride
    },
    deps
  );

  const warnings: string[] = [];
  const installSpec = settings.installSpec?.trim() ? settings.installSpec.trim() : `${packageName}@latest`;
  const updateArgs = ['install', '--global', installSpec];
  let updateCommand: { command: string; args: string[] } | undefined;

  if (compareSemver(check.currentVersion, check.latestVersion) < 0) {
    updateCommand = {
      command: npmCommand,
      args: updateArgs
    };
    const installResult = await runner(npmCommand, updateArgs);
    if (installResult.code !== 0) {
      throw new Error(
        `Upgrade failed while running "${npmCommand} ${updateArgs.join(' ')}": ${installResult.stderr.trim() || installResult.stdout.trim() || 'unknown error'}`
      );
    }
  }

  const verifyCommand = {
    command: process.platform === 'win32' ? 'xyte-cli.cmd' : 'xyte-cli',
    args: ['--version']
  };
  const verifyResult = await runner(verifyCommand.command, verifyCommand.args);
  if (verifyResult.code !== 0) {
    throw new Error(`Upgrade verification failed: unable to run "xyte-cli --version".`);
  }
  const detectedVersion = parseVersionFromOutput(verifyResult.stdout.trim());
  if (!detectedVersion) {
    throw new Error(`Upgrade verification failed: could not parse version from "xyte-cli --version" output.`);
  }
  if (compareSemver(detectedVersion, check.latestVersion) < 0) {
    throw new Error(`Upgrade verification failed: detected ${detectedVersion}, expected at least ${check.latestVersion}.`);
  }

  const skills = await installSkillsImpl({
    skillName: 'xyte-cli',
    sourceDir: settings.skillSourceDir,
    scope: 'user',
    agents: [...DEFAULT_SKILL_AGENTS],
    force: true
  });
  const failedOutcomes = skills.outcomes.filter((outcome) => outcome.status === 'failed');
  if (failedOutcomes.length > 0) {
    warnings.push(`Skill refresh failed for ${failedOutcomes.length} destination(s).`);
  }

  return {
    schemaVersion: UPGRADE_RESULT_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    packageName,
    currentVersion: check.currentVersion,
    latestVersion: check.latestVersion,
    upToDateBefore: check.upToDate,
    updated: Boolean(updateCommand),
    updateCommand,
    verify: {
      command: verifyCommand,
      detectedVersion,
      expectedVersion: check.latestVersion,
      match: compareSemver(detectedVersion, check.latestVersion) >= 0
    },
    skills: {
      scope: 'user',
      agents: [...DEFAULT_SKILL_AGENTS],
      force: true,
      sourceDir: skills.sourceDir,
      outcomes: skills.outcomes as SkillInstallOutcome[],
      failedCount: failedOutcomes.length
    },
    warnings
  };
}
