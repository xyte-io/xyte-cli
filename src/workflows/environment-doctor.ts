import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describeSecretStore, type SecretStoreDiagnostics } from '../secure/secret-store';
import { getXyteConfigDir } from '../utils/config-dir';
import { getEnvPathValue } from '../utils/env-path';
import { errorMessage } from '../utils/error-format';
import { resolveCommandFromPath } from '../utils/resolve-command-path';

const PACKAGE_NAME = '@xyteai/cli';
const MIN_NODE_MAJOR = 22;
const NPM_PACKAGE_URL = 'https://registry.npmjs.org/@xyteai%2fcli/latest';

export type EnvironmentDoctorStatus = 'ok' | 'restricted' | 'blocked';
export type EnvironmentDoctorMode = 'existing' | 'npx' | 'workspace-local' | 'blocked';

export interface EnvironmentCheck {
  status: 'ok' | 'restricted' | 'blocked';
  message: string;
}

export interface EnvironmentPathCheck {
  status: 'ok' | 'blocked';
  path: string;
  message: string;
}

export interface EnvironmentSecretStoreCheck {
  status: 'ok' | 'restricted';
  selector?: string;
  backend?: string;
  location?: string;
  message: string;
}

export interface EnvironmentNetworkCheck {
  status: 'ok' | 'blocked' | 'skipped';
  url: string;
  message: string;
}

export interface EnvironmentToolReport {
  available: boolean;
  path?: string;
  version?: string;
  required?: string;
}

export interface EnvironmentCommands {
  doctor: string;
  setupKeyFile: string;
  setupStdin: string;
  setupKeyCommand: string;
  initAgentSkills: string;
}

export interface EnvironmentDoctorReport {
  schemaVersion: 'xyte.doctor.environment.v1';
  generatedAtUtc: string;
  status: EnvironmentDoctorStatus;
  environment: {
    platform: string;
    arch: string;
    cwd: string;
    home: string | null;
    tempDir: string;
    configDir: string;
    currentCommandPath?: string;
    node: EnvironmentToolReport;
    npm: EnvironmentToolReport;
    npx: EnvironmentToolReport;
    xyteCli: EnvironmentToolReport;
  };
  checks: {
    nodeVersion: EnvironmentCheck;
    cwdWritable: EnvironmentPathCheck;
    homeWritable: EnvironmentPathCheck;
    tempWritable: EnvironmentPathCheck;
    configDirWritable: EnvironmentPathCheck;
    workspaceRuntimeWritable: EnvironmentPathCheck;
    configDirOutsideWorkspace: EnvironmentCheck;
    secretStore: EnvironmentSecretStoreCheck;
    network: EnvironmentNetworkCheck;
  };
  recommendations: {
    mode: EnvironmentDoctorMode;
    nextCommand: string;
    commandPrefix?: string;
    installCommand?: string;
    commands?: EnvironmentCommands;
    notes: string[];
  };
}

export interface EnvironmentDoctorOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  homeDir?: string;
  tempDir?: string;
  configDir?: string;
  currentCommandPath?: string;
  checkNetwork?: boolean;
  now?: Date;
  nodePath?: string;
  nodeVersion?: string;
  commandResolver?: (command: string, envPath?: string) => string | undefined;
  writableProbe?: (dirPath: string) => Promise<EnvironmentPathCheck>;
  secretStoreDiagnostics?: () => Promise<SecretStoreDiagnostics>;
  networkProbe?: () => Promise<EnvironmentNetworkCheck>;
}

function pathApiFor(platform: NodeJS.Platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function parseNodeMajor(version: string): number | undefined {
  const match = version.trim().match(/^v?(\d+)/);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

async function defaultWritableProbe(dirPath: string): Promise<EnvironmentPathCheck> {
  const createdDirs: string[] = [];
  try {
    const missing: string[] = [];
    let ancestor = path.resolve(dirPath);
    while (!(await pathExists(ancestor))) {
      missing.unshift(ancestor);
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        break;
      }
      ancestor = parent;
    }
    if (missing.length > 0) {
      await fs.mkdir(path.resolve(dirPath), { recursive: true });
      createdDirs.push(...missing);
    }

    const probePath = path.join(dirPath, `.xyte-cli-doctor-${randomUUID()}.tmp`);
    await fs.writeFile(probePath, 'ok', 'utf8');
    await fs.unlink(probePath);
    return { status: 'ok', path: dirPath, message: 'Writable.' };
  } catch (error) {
    return { status: 'blocked', path: dirPath, message: errorMessage(error) };
  } finally {
    for (const dir of createdDirs.reverse()) {
      try {
        await fs.rmdir(dir);
      } catch {
        // A non-empty directory means another process used it; leave it alone.
      }
    }
  }
}

async function defaultNetworkProbe(): Promise<EnvironmentNetworkCheck> {
  try {
    const response = await fetch(NPM_PACKAGE_URL, { method: 'GET', signal: AbortSignal.timeout(3000) });
    return response.ok
      ? { status: 'ok', url: NPM_PACKAGE_URL, message: 'npm registry reachable.' }
      : { status: 'blocked', url: NPM_PACKAGE_URL, message: `npm registry returned HTTP ${response.status}.` };
  } catch (error) {
    return { status: 'blocked', url: NPM_PACKAGE_URL, message: errorMessage(error) };
  }
}

function buildCommands(prefix: string, platform: NodeJS.Platform): EnvironmentCommands {
  const stdinSource = platform === 'win32' ? 'Get-Content <path-outside-workspace>' : '<secret-command>';
  return {
    doctor: `${prefix} doctor environment --format json`,
    setupKeyFile: `${prefix} setup run --non-interactive --tenant <tenant-id> --key-file <path-outside-workspace> --output json`,
    setupStdin: `${stdinSource} | ${prefix} setup run --non-interactive --tenant <tenant-id> --key-stdin --output json`,
    setupKeyCommand: `${prefix} setup run --non-interactive --tenant <tenant-id> --key-command "<cmd>" --output json`,
    initAgentSkills: `${prefix} init --scope project --agents all --force --no-setup`
  };
}

function isPathInside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const pathApi = pathApiFor(platform);
  const relative = pathApi.relative(pathApi.resolve(parent), pathApi.resolve(parent, child));
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative));
}

function runnableCommandPrefix(commandPath: string | undefined): string | undefined {
  if (!commandPath) {
    return undefined;
  }
  return /\.[cm]?js$/i.test(commandPath) ? `node ${commandPath}` : commandPath;
}

function isNpxEphemeralPath(commandPath: string | undefined): boolean {
  if (!commandPath) {
    return false;
  }
  const normalized = commandPath.replaceAll('\\', '/').toLowerCase();
  return /\/_npx\/[^/]+\/node_modules\/\.bin\/xyte-cli(?:\.cmd)?$/.test(normalized);
}

function buildRecommendations(args: {
  mode: EnvironmentDoctorMode;
  platform: NodeJS.Platform;
  existingPrefix?: string;
  notes: string[];
}): EnvironmentDoctorReport['recommendations'] {
  const { mode, platform, notes } = args;

  if (mode === 'blocked') {
    return {
      mode,
      nextCommand: 'Install Node.js 22+ or preinstall xyte-cli, then rerun xyte-cli doctor environment --format json.',
      notes: [
        'No runnable xyte-cli path can be established from this environment.',
        'Install Node.js 22+, preinstall xyte-cli, or move to a shell-capable terminal/agent.',
        ...notes
      ]
    };
  }

  let prefix: string;
  let installCommand: string | undefined;
  if (mode === 'existing') {
    prefix = args.existingPrefix ?? 'xyte-cli';
  } else if (mode === 'npx') {
    prefix = `npx -y ${PACKAGE_NAME}@latest`;
  } else {
    prefix =
      platform === 'win32'
        ? '.\\.xyte-cli\\runtime\\node_modules\\.bin\\xyte-cli.cmd'
        : './.xyte-cli/runtime/node_modules/.bin/xyte-cli';
    installCommand = `npm install --prefix ./.xyte-cli/runtime ${PACKAGE_NAME}@latest`;
  }

  return {
    mode,
    nextCommand: `${prefix} doctor environment --format json`,
    commandPrefix: prefix,
    installCommand,
    commands: buildCommands(prefix, platform),
    notes
  };
}

export async function buildEnvironmentDoctorReport(
  options: EnvironmentDoctorOptions = {}
): Promise<EnvironmentDoctorReport> {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const envPath = getEnvPathValue(env, platform);
  const home = (options.homeDir ?? os.homedir()) || null;
  const tempDir = options.tempDir ?? os.tmpdir();
  const configDir = options.configDir ?? getXyteConfigDir(env);
  const nodeVersion = options.nodeVersion ?? process.version;
  const nodeMajor = parseNodeMajor(nodeVersion);
  const nodeOk = nodeMajor !== undefined && nodeMajor >= MIN_NODE_MAJOR;
  const resolveCommand = options.commandResolver ?? resolveCommandFromPath;
  const writableProbe = options.writableProbe ?? defaultWritableProbe;
  const pathApi = pathApiFor(platform);

  const [cwdWritable, homeWritable, tempWritable, configDirWritable, workspaceRuntimeWritable, secretStore, network] =
    await Promise.all([
      writableProbe(cwd),
      home
        ? writableProbe(home)
        : Promise.resolve<EnvironmentPathCheck>({ status: 'blocked', path: '', message: 'HOME is unavailable.' }),
      writableProbe(tempDir),
      writableProbe(configDir),
      writableProbe(pathApi.join(cwd, '.xyte-cli', 'runtime')),
      buildSecretStoreCheck(options.secretStoreDiagnostics ?? (() => describeSecretStore({ cwd, env, platform }))),
      options.checkNetwork
        ? (options.networkProbe ?? defaultNetworkProbe)()
        : Promise.resolve<EnvironmentNetworkCheck>({
            status: 'skipped',
            url: NPM_PACKAGE_URL,
            message: 'Network check skipped. Pass --check-network to probe npm registry reachability.'
          })
    ]);

  const npm = toolReport(resolveCommand('npm', envPath));
  const npx = toolReport(resolveCommand('npx', envPath));
  const resolvedXyteCli = toolReport(resolveCommand('xyte-cli', envPath));
  const resolvedXyteCliIsDurable = resolvedXyteCli.available && !isNpxEphemeralPath(resolvedXyteCli.path);
  const currentCommandIsDurableCli = Boolean(
    options.currentCommandPath &&
    pathApi.basename(options.currentCommandPath).includes('xyte-cli') &&
    !isNpxEphemeralPath(options.currentCommandPath)
  );
  const xyteCli: EnvironmentToolReport = resolvedXyteCli.available
    ? resolvedXyteCli
    : currentCommandIsDurableCli
      ? { available: true, path: options.currentCommandPath }
      : { available: false };
  const node: EnvironmentToolReport = {
    available: true,
    path: options.nodePath ?? process.execPath,
    version: nodeVersion,
    required: `>=${MIN_NODE_MAJOR}`
  };

  const nodeVersionCheck: EnvironmentCheck = {
    status: nodeOk ? 'ok' : 'blocked',
    message: nodeOk
      ? `Node ${nodeVersion} satisfies >=${MIN_NODE_MAJOR}.`
      : `Node ${nodeVersion} does not satisfy >=${MIN_NODE_MAJOR}.`
  };

  const configDirIsOutsideWorkspace = !isPathInside(configDir, cwd, platform);
  const configDirOutsideWorkspace: EnvironmentCheck = {
    status: configDirIsOutsideWorkspace ? 'ok' : 'restricted',
    message: configDirIsOutsideWorkspace
      ? 'Config directory is outside the workspace.'
      : 'Config directory is inside the workspace; do not store secrets in the repo.'
  };

  const registryUnreachable = network.status === 'blocked';
  let mode: EnvironmentDoctorMode = 'blocked';
  if (nodeOk && (resolvedXyteCliIsDurable || currentCommandIsDurableCli)) {
    mode = 'existing';
  } else if (nodeOk && npx.available && !registryUnreachable) {
    mode = 'npx';
  } else if (
    nodeOk &&
    npm.available &&
    !registryUnreachable &&
    cwdWritable.status === 'ok' &&
    workspaceRuntimeWritable.status === 'ok'
  ) {
    mode = 'workspace-local';
  }

  const configUsable = configDirWritable.status === 'ok' && configDirIsOutsideWorkspace;
  const fallbackConfigUsable = tempWritable.status === 'ok' || homeWritable.status === 'ok';
  let status: EnvironmentDoctorStatus;
  if (mode === 'blocked' || (!configUsable && !fallbackConfigUsable)) {
    status = 'blocked';
  } else if (
    mode === 'workspace-local' ||
    !configUsable ||
    secretStore.status !== 'ok' ||
    homeWritable.status !== 'ok' ||
    cwdWritable.status !== 'ok'
  ) {
    status = 'restricted';
  } else {
    status = 'ok';
  }

  const notes = ['Do not paste API keys into AI chat or store API keys inside the repo.'];
  if (!configUsable) {
    notes.push('Use XYTE_CLI_CONFIG_DIR outside the workspace or under a temp directory for setup.');
  }
  if (secretStore.status !== 'ok') {
    notes.push('Use --key-stdin, --key-command, or --key-file <path-outside-workspace> for non-interactive setup.');
  }
  if (homeWritable.status !== 'ok') {
    notes.push('HOME is not writable; avoid relying on shell profile or global PATH persistence.');
  }
  if (tempWritable.status !== 'ok') {
    notes.push('Temp directory is not writable; provide a writable config directory before setup.');
  }

  return {
    schemaVersion: 'xyte.doctor.environment.v1',
    generatedAtUtc: (options.now ?? new Date()).toISOString(),
    status,
    environment: {
      platform,
      arch,
      cwd,
      home,
      tempDir,
      configDir,
      currentCommandPath: options.currentCommandPath,
      node,
      npm,
      npx,
      xyteCli
    },
    checks: {
      nodeVersion: nodeVersionCheck,
      cwdWritable,
      homeWritable,
      tempWritable,
      configDirWritable,
      workspaceRuntimeWritable,
      configDirOutsideWorkspace,
      secretStore,
      network
    },
    recommendations: buildRecommendations({
      mode,
      platform,
      existingPrefix: resolvedXyteCliIsDurable ? 'xyte-cli' : runnableCommandPrefix(options.currentCommandPath),
      notes
    })
  };
}

function toolReport(commandPath: string | undefined): EnvironmentToolReport {
  return commandPath ? { available: true, path: commandPath } : { available: false };
}

async function buildSecretStoreCheck(
  diagnostics: () => Promise<SecretStoreDiagnostics>
): Promise<EnvironmentSecretStoreCheck> {
  try {
    const result = await diagnostics();
    const native = result.backend !== 'file';
    return {
      status: native ? 'ok' : 'restricted',
      selector: result.selector,
      backend: result.backend,
      location: result.secretStore,
      message: native
        ? 'Native secret storage is available.'
        : 'Native secret storage is unavailable or file storage is selected.'
    };
  } catch (error) {
    return { status: 'restricted', message: errorMessage(error) };
  }
}

export function formatEnvironmentDoctorText(report: EnvironmentDoctorReport): string {
  const lines = [
    `Status: ${report.status}`,
    `Mode: ${report.recommendations.mode}`,
    `Next command: ${report.recommendations.nextCommand}`
  ];
  if (report.recommendations.installCommand) {
    lines.push(`Install command: ${report.recommendations.installCommand}`);
  }
  if (report.recommendations.notes.length > 0) {
    lines.push('Notes:');
    for (const note of report.recommendations.notes) {
      lines.push(`- ${note}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
