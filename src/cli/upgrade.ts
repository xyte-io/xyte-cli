import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import type { SkillAgent, SkillInstallOutcome } from './install-skills';
import { installSkills } from './install-skills';
import { CliUserError } from '../contracts/user-error';
import { runProcess } from '../utils/run-command';
import { getCliVersion } from '../utils/version';
import { buildUpgradeCheck, type UpgradeCheckV1, type UpgradeResultV1 } from '../contracts/upgrade';
import { UPGRADE_RESULT_SCHEMA_VERSION } from '../contracts/versions';
import { detectInstallChannel, WINDOWS_MSI_PACKAGE_ID, type InstallChannel } from '../utils/install-channel';

const DEFAULT_CLI_PACKAGE = '@xyteai/cli';
const DEFAULT_SKILL_AGENTS: SkillAgent[] = ['claude', 'copilot', 'codex'];

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (command: string, args: string[]) => Promise<CommandResult>;
/** Starts a command that outlives this process and resolves once it has spawned. */
export type DetachedLauncher = (command: string, args: string[]) => Promise<void>;

export interface UpgradeDependencies {
  fetchImpl?: typeof fetch;
  commandRunner?: CommandRunner;
  detachedLauncher?: DetachedLauncher;
  installSkillsImpl?: typeof installSkills;
  getCurrentVersion?: () => string;
  getInstallChannel?: () => InstallChannel;
  npmCommand?: string;
}

interface UpgradeSettings {
  packageName?: string;
  skillSourceDir: string;
  installSpec?: string;
  latestVersionOverride?: string;
  /** windows-msi only: launch winget in a console window (a human is at a TTY with text output). Otherwise the command is returned for the caller to run. */
  launchInteractive?: boolean;
}

import { compareSemver } from '../contracts/semver';

function defaultRunner(command: string, args: string[]): Promise<CommandResult> {
  return runProcess(command, args, { stdinMode: 'ignore' });
}

function parseVersionFromOutput(output: string): string | undefined {
  const match = output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match ? match[0] : undefined;
}

const STRICT_SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// winget must not run as a child of the node.exe it replaces (locked files, restart
// prompts), so it gets the full non-interactive flag set and runs after this process
// exits. The id and flags are constants and the version is strict semver, which is
// what makes these args safe to pass through cmd.exe.
function buildWingetUpgradeArgs(targetVersion?: string): string[] {
  return [
    'upgrade',
    '--id',
    WINDOWS_MSI_PACKAGE_ID,
    '--exact',
    ...(targetVersion ? ['--version', targetVersion] : []),
    '--source',
    'winget',
    '--accept-source-agreements',
    '--accept-package-agreements',
    '--silent'
  ];
}

function buildRecommendedUpdateCommand(packageName: string, installChannel: InstallChannel): string {
  if (installChannel.kind === 'windows-msi') {
    return `winget ${buildWingetUpgradeArgs().join(' ')}`;
  }
  return `npm install --global ${packageName}@latest`;
}

/**
 * Absolute path to winget.exe. Never resolved by bare name: Windows searches the
 * current directory first, so a winget.exe planted in a repo would run instead.
 */
export function resolveWingetPath(
  env: NodeJS.ProcessEnv = process.env,
  exists: (filePath: string) => boolean = existsSync,
  cwd: string = process.cwd()
): string {
  const win = path.win32;
  const candidates: string[] = [];
  if (env.LOCALAPPDATA && win.isAbsolute(env.LOCALAPPDATA)) {
    candidates.push(win.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe'));
  }
  const pathValue = env.Path ?? env.PATH ?? '';
  for (const rawEntry of pathValue.split(';')) {
    const entry = rawEntry.trim().replace(/^"(.*)"$/, '$1');
    if (!entry || !win.isAbsolute(entry) || win.resolve(entry).toLowerCase() === win.resolve(cwd).toLowerCase()) {
      continue;
    }
    candidates.push(win.join(entry, 'winget.exe'));
  }
  const found = candidates.find((candidate) => exists(candidate));
  if (!found) {
    throw new CliUserError({ summary: 'winget.exe was not found in %LOCALAPPDATA%\\Microsoft\\WindowsApps or on PATH.' });
  }
  // The path is quoted for cmd.exe below; these characters would break out of that quoting.
  if (/["%&<>()@^|!]/.test(found)) {
    throw new CliUserError({ summary: `winget path "${found}" contains characters that cannot be passed safely through cmd.exe.` });
  }
  return found;
}

/**
 * cmd.exe argv that opens a new console window running winget and keeps it open
 * (`cmd /k`) after winget exits, so its output and errors stay readable.
 */
export function buildWingetConsoleArgs(wingetPath: string, args: string[]): string[] {
  return ['/d', '/c', 'start', '"Xyte CLI upgrade"', 'cmd.exe', '/d', '/k', `"${wingetPath}"`, ...args];
}

function defaultDetachedLauncher(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let wingetPath: string;
    try {
      wingetPath = command === 'winget' ? resolveWingetPath() : command;
    } catch (error) {
      reject(error);
      return;
    }
    // `start` gives winget its own console window; detached + stdio ignore lets the
    // short-lived outer cmd.exe (and this process) exit without waiting for it.
    const child = spawn('cmd.exe', buildWingetConsoleArgs(wingetPath, args), {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function fetchLatestVersion(packageName: string, fetchImpl: typeof fetch): Promise<string> {
  const encodedName = encodeURIComponent(packageName);
  const response = await fetchImpl(`https://registry.npmjs.org/${encodedName}/latest`, {
    headers: {
      accept: 'application/json'
    }
  });

  if (!response.ok) {
    throw new CliUserError({ summary: `Failed to fetch latest version for ${packageName} (HTTP ${response.status}).` });
  }

  const payload = (await response.json()) as { version?: unknown };
  if (typeof payload.version !== 'string' || !payload.version.trim()) {
    throw new CliUserError({ summary: `Latest version response for ${packageName} is missing a valid version.` });
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
  const installChannel = (deps.getInstallChannel ?? detectInstallChannel)();
  const latestVersion =
    typeof settings.latestVersionOverride === 'string' && settings.latestVersionOverride.trim()
      ? settings.latestVersionOverride.trim()
      : await fetchLatestVersion(packageName, fetchImpl);
  return buildUpgradeCheck({
    packageName,
    installChannel: installChannel.kind,
    recommendedCommand: buildRecommendedUpdateCommand(packageName, installChannel),
    currentVersion,
    latestVersion
  });
}

export async function applyUpgrade(
  settings: UpgradeSettings,
  deps: UpgradeDependencies = {}
): Promise<UpgradeResultV1> {
  const packageName = settings.packageName ?? DEFAULT_CLI_PACKAGE;
  const runner = deps.commandRunner ?? defaultRunner;
  const installSkillsImpl = deps.installSkillsImpl ?? installSkills;
  const launchDetached = deps.detachedLauncher ?? defaultDetachedLauncher;
  const installChannel = (deps.getInstallChannel ?? detectInstallChannel)();
  if (installChannel.kind === 'windows-msi' && settings.installSpec?.trim()) {
    throw new CliUserError({
      summary:
        'XYTE_CLI_UPGRADE_SPEC is not supported on the windows-msi install channel. Unset it, or use XYTE_CLI_UPGRADE_TARGET_VERSION to pick a winget version.'
    });
  }
  const requestedVersion = settings.latestVersionOverride?.trim();
  if (installChannel.kind === 'windows-msi' && requestedVersion && !STRICT_SEMVER.test(requestedVersion)) {
    throw new CliUserError({
      summary: `XYTE_CLI_UPGRADE_TARGET_VERSION "${requestedVersion}" is not a valid version (expected e.g. 1.2.3 or 1.2.3-rc.1).`
    });
  }
  const npmCommand = deps.npmCommand ?? (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const check = await checkForUpgrade(
    {
      packageName,
      latestVersionOverride: settings.latestVersionOverride
    },
    {
      ...deps,
      getInstallChannel: () => installChannel
    }
  );

  const warnings: string[] = [];
  const targetVersion = settings.latestVersionOverride?.trim() || undefined;

  if (installChannel.kind === 'windows-msi') {
    const baseResult = {
      schemaVersion: UPGRADE_RESULT_SCHEMA_VERSION,
      generatedAtUtc: new Date().toISOString(),
      packageName,
      installChannel: installChannel.kind,
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      upToDateBefore: check.upToDate,
      updated: false,
      warnings
    };
    // Already current: nothing to hand off, and the npm verify / skills refresh below
    // does not apply to an MSI install.
    if (compareSemver(check.currentVersion, check.latestVersion) >= 0) {
      return baseResult;
    }
    const updateCommand = { command: 'winget', args: buildWingetUpgradeArgs(targetVersion) };
    if (!settings.launchInteractive) {
      return { ...baseResult, updateCommand, handoff: { tool: 'winget' as const, status: 'manual' as const } };
    }
    try {
      await launchDetached(updateCommand.command, updateCommand.args);
    } catch (error) {
      throw new CliUserError({
        summary: `Could not start "winget": ${error instanceof Error ? error.message : String(error)}. Install App Installer (winget) or download the newer MSI.`
      });
    }
    return { ...baseResult, updateCommand, handoff: { tool: 'winget' as const, status: 'started' as const } };
  }

  const installSpec = settings.installSpec?.trim()
    ? settings.installSpec.trim()
    : targetVersion
      ? `${packageName}@${targetVersion}`
      : `${packageName}@latest`;
  let updateCommand: { command: string; args: string[] } | undefined;

  if (compareSemver(check.currentVersion, check.latestVersion) < 0) {
    updateCommand = {
      command: npmCommand,
      args: ['install', '--global', installSpec]
    };
    const installResult = await runner(updateCommand.command, updateCommand.args);
    if (installResult.code !== 0) {
      throw new CliUserError({
        summary: `Upgrade failed while running "${updateCommand.command} ${updateCommand.args.join(' ')}": ${installResult.stderr.trim() || installResult.stdout.trim() || 'unknown error'}`
      });
    }
  }

  const verifyCommand = {
    command: process.platform === 'win32' ? 'xyte-cli.cmd' : 'xyte-cli',
    args: ['--version']
  };
  const verifyResult = await runner(verifyCommand.command, verifyCommand.args);
  if (verifyResult.code !== 0) {
    throw new CliUserError({ summary: `Upgrade verification failed: unable to run "xyte-cli --version".` });
  }
  const detectedVersion = parseVersionFromOutput(verifyResult.stdout.trim());
  if (!detectedVersion) {
    throw new CliUserError({ summary: `Upgrade verification failed: could not parse version from "xyte-cli --version" output.` });
  }
  if (compareSemver(detectedVersion, check.latestVersion) < 0) {
    throw new CliUserError({
      summary: `Upgrade verification failed: detected ${detectedVersion}, expected at least ${check.latestVersion}.`
    });
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
    installChannel: installChannel.kind,
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
