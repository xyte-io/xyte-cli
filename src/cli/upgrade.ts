import type { SkillAgent, SkillInstallOutcome } from './install-skills';
import { installSkills } from './install-skills';
import { CliUserError } from '../contracts/user-error';
import { runProcess } from '../utils/run-command';
import { getCliVersion } from '../utils/version';
import { buildUpgradeCheck, type UpgradeCheckV1, type UpgradeResultV1 } from '../contracts/upgrade';
import { UPGRADE_RESULT_SCHEMA_VERSION } from '../contracts/versions';
import { detectInstallChannel, type InstallChannel } from '../utils/install-channel';

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
  getInstallChannel?: () => InstallChannel;
  npmCommand?: string;
}

interface UpgradeSettings {
  packageName?: string;
  skillSourceDir: string;
  installSpec?: string;
  latestVersionOverride?: string;
}

import { compareSemver } from '../contracts/semver';

function defaultRunner(command: string, args: string[]): Promise<CommandResult> {
  return runProcess(command, args, { stdinMode: 'ignore' });
}

function parseVersionFromOutput(output: string): string | undefined {
  const match = output.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match ? match[0] : undefined;
}

function buildRecommendedUpdateCommand(packageName: string, installChannel: InstallChannel): string {
  if (installChannel.kind === 'windows-msi') {
    return `winget upgrade --id ${installChannel.packageId ?? 'Xyte.XyteCLI'} --exact`;
  }
  return `npm install --global ${packageName}@latest`;
}

function buildExecutableUpdateCommand(args: {
  installChannel: InstallChannel;
  installSpec: string;
  npmCommand: string;
}): { command: string; args: string[] } {
  if (args.installChannel.kind === 'windows-msi') {
    return {
      command: 'winget',
      args: ['upgrade', '--id', args.installChannel.packageId ?? 'Xyte.XyteCLI', '--exact']
    };
  }

  return {
    command: args.npmCommand,
    args: ['install', '--global', args.installSpec]
  };
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
  const installChannel = (deps.getInstallChannel ?? detectInstallChannel)();
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
  const installSpec = settings.installSpec?.trim()
    ? settings.installSpec.trim()
    : typeof settings.latestVersionOverride === 'string' && settings.latestVersionOverride.trim()
      ? `${packageName}@${settings.latestVersionOverride.trim()}`
      : `${packageName}@latest`;
  let updateCommand: { command: string; args: string[] } | undefined;

  if (compareSemver(check.currentVersion, check.latestVersion) < 0) {
    updateCommand = buildExecutableUpdateCommand({
      installChannel,
      installSpec,
      npmCommand
    });
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
