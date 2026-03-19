import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

export const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
export const XYTE_COMMAND = process.platform === 'win32' ? 'xyte-cli.cmd' : 'xyte-cli';
export const NODE_COMMAND = process.platform === 'win32' ? 'node.exe' : 'node';

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  stdinMode?: 'pipe' | 'ignore';
}

export interface IsolatedEnvDirs {
  homeDir: string;
  configDir: string;
  prefixDir: string;
  npmCacheDir: string;
}

export interface LoggerLike {
  log: (message: string) => void;
}

function shouldUseWindowsShell(command: string): boolean {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

interface SpawnPlan {
  command: string;
  args: string[];
  shell?: boolean;
}

function quoteWindowsCmdArg(value: string): string {
  if (!value) {
    return '""';
  }
  if (!/[ \t"&()<>^[\]|]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

export function buildSpawnPlan(command: string, args: string[], platform: NodeJS.Platform = process.platform): SpawnPlan {
  const isWindowsShellScript = platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  if (!isWindowsShellScript) {
    return {
      command,
      args,
      shell: false
    };
  }

  const comspec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
  const commandLine = [quoteWindowsCmdArg(command), ...args.map((arg) => quoteWindowsCmdArg(arg))].join(' ');

  return {
    command: comspec,
    args: ['/d', '/s', '/c', commandLine],
    shell: false
  };
}

export function normalizeJsonOutput(raw: unknown): any {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    throw new Error('Expected JSON output but got empty stdout.');
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // fall back to scanning trailing lines for JSON payloads
  }

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // continue scanning
    }
  }

  throw new Error(`Expected JSON output but parsing failed. stdout=${trimmed}`);
}

export function buildIsolatedEnv(baseEnv: NodeJS.ProcessEnv, dirs: IsolatedEnvDirs): NodeJS.ProcessEnv {
  const appData = path.join(dirs.homeDir, 'AppData', 'Roaming');
  const xdgConfigHome = path.join(dirs.homeDir, '.config');

  return {
    ...baseEnv,
    HOME: dirs.homeDir,
    USERPROFILE: dirs.homeDir,
    APPDATA: appData,
    XDG_CONFIG_HOME: xdgConfigHome,
    XYTE_CLI_CONFIG_DIR: dirs.configDir,
    NPM_CONFIG_PREFIX: dirs.prefixDir,
    npm_config_prefix: dirs.prefixDir,
    npm_config_cache: dirs.npmCacheDir,
    PATH: baseEnv.PATH ?? ''
  };
}

export async function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<CommandResult> {
  const stdinMode = options.stdinMode ?? 'pipe';
  const spawnPlan = buildSpawnPlan(command, args);

  return await new Promise((resolve, reject) => {
    const child = spawn(spawnPlan.command, spawnPlan.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [stdinMode, 'pipe', 'pipe'],
      shell: spawnPlan.shell,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });

    if (stdinMode === 'pipe' && child.stdin) {
      child.stdin.on('error', (error) => reject(error));
      if (options.input === undefined) {
        child.stdin.end();
      } else {
        child.stdin.end(options.input);
      }
    }
  });
}

export function assertSuccess(result: CommandResult, label: string, command: string, args: string[]): void {
  if (result.code === 0) {
    return;
  }

  const rendered = [
    `${command} ${args.join(' ')}`.trim(),
    result.stdout ? `stdout:\n${result.stdout.trim()}` : '',
    result.stderr ? `stderr:\n${result.stderr.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n\n');

  throw new Error(`${label} failed with exit code ${result.code}.\n${rendered}`);
}

export function parsePackFilename(packStdout: unknown): string {
  const trimmed = String(packStdout ?? '').trim();
  if (!trimmed) {
    throw new Error('npm pack returned empty stdout.');
  }

  try {
    const payload = JSON.parse(trimmed);
    if (Array.isArray(payload) && payload[0]?.filename) {
      return String(payload[0].filename);
    }
    if (payload?.filename) {
      return String(payload.filename);
    }
  } catch {
    // fallback to final line mode
  }

  const lines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines[lines.length - 1];
}

export function printStep(logger: LoggerLike, index: number, total: number, label: string): void {
  logger.log(`[${index}/${total}] ${label}`);
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}
