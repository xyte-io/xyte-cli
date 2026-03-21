import { mkdtemp, mkdir, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path, { delimiter } from 'node:path';

import { getEnvPathValue, setEnvPathValue } from '../utils/env-path';
import {
  NODE_COMMAND,
  NPM_COMMAND,
  XYTE_COMMAND,
  assertSuccess,
  buildIsolatedEnv,
  normalizeJsonOutput,
  parsePackFilename,
  pathExists,
  printStep,
  runCommand,
  type LoggerLike,
  type RunCommandOptions
} from './shared';

const SKILL_MANIFEST_VALIDATION_SCRIPT = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const workspaceRoot = process.env.XYTE_SMOKE_WORKSPACE;',
  'const homeRoot = process.env.XYTE_SMOKE_HOME;',
  'if (!workspaceRoot || !homeRoot) {',
  '  throw new Error("Missing XYTE_SMOKE_WORKSPACE or XYTE_SMOKE_HOME for skill manifest check.");',
  '}',
  'const checks = [',
  "  { path: path.join(workspaceRoot, '.claude', 'skills', 'xyte-cli', 'SKILL.md'), marker: 'Use xyte-cli commands directly.', label: 'Project Claude skill manifest' },",
  "  { path: path.join(workspaceRoot, '.github', 'skills', 'xyte-cli', 'SKILL.md'), marker: 'Use xyte-cli commands directly.', label: 'Project Copilot skill manifest' },",
  "  { path: path.join(workspaceRoot, '.agents', 'skills', 'xyte-cli', 'SKILL.md'), marker: 'Use xyte-cli commands directly.', label: 'Project Codex skill manifest' },",
  `  { path: path.join(homeRoot, '.claude', 'skills', 'xyte-cli', 'SKILL.md'), marker: '$xyte-cli', label: 'User Claude skill manifest' },`,
  `  { path: path.join(homeRoot, '.copilot', 'skills', 'xyte-cli', 'SKILL.md'), marker: '$xyte-cli', label: 'User Copilot skill manifest' },`,
  `  { path: path.join(homeRoot, '.agents', 'skills', 'xyte-cli', 'SKILL.md'), marker: '$xyte-cli', label: 'User Codex skill manifest' },`,
  `  { path: path.join(workspaceRoot, '.claude', 'skills', 'xyte-cli', 'agents', 'openai.yaml'), marker: '$xyte-cli', label: 'OpenAI agent manifest' }`,
  '];',
  'for (const check of checks) {',
  '  const content = fs.readFileSync(check.path, "utf8");',
  '  if (!content.includes(check.marker)) {',
  '    throw new Error(`Manifest ${check.label} at ${check.path} is not actionable for xyte-cli.`);',
  '  }',
  '}',
  'console.log("Skill manifests are present and actionable for xyte-cli automation.");'
].join(' ');

export interface SmokeInputs {
  key: string;
  tenant: string;
}

export interface ExternalLiveSmokeOptions {
  cwd?: string;
  logger?: LoggerLike;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[], options?: RunCommandOptions) => Promise<{ code: number; stdout: string; stderr: string }>;
  pathExistsFn?: typeof pathExists;
  mkdtempFn?: (prefix: string) => Promise<string>;
  mkdirFn?: (path: string, options?: { recursive?: boolean }) => Promise<unknown>;
  rmFn?: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<unknown>;
  unlinkFn?: (path: string) => Promise<unknown>;
}

export function resolveSmokeInputs(env: NodeJS.ProcessEnv = process.env): SmokeInputs {
  const key = env.XYTE_CLI_KEY?.trim();
  if (!key) {
    throw new Error('Missing XYTE_CLI_KEY. Set a real key before running smoke:external-live.');
  }

  const tenant = env.XYTE_E2E_TENANT?.trim() || 'default';
  return { key, tenant };
}

export async function runExternalUserLiveSmoke(options: ExternalLiveSmokeOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? console;
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const pathExistsFn = options.pathExistsFn ?? pathExists;

  const { key, tenant } = resolveSmokeInputs(env);
  const stepTotal = 8;

  let tarballPath: string | undefined;
  const tempRoot = await (options.mkdtempFn ?? mkdtemp)(path.join(tmpdir(), 'xyte-cli-smoke-'));
  const dirs = {
    homeDir: path.join(tempRoot, 'home'),
    workspaceDir: path.join(tempRoot, 'workspace'),
    configDir: path.join(tempRoot, 'config'),
    prefixDir: path.join(tempRoot, 'npm-prefix'),
    npmCacheDir: path.join(tempRoot, 'npm-cache'),
    globalBinDir: path.join(tempRoot, 'npm-prefix', process.platform === 'win32' ? '' : 'bin')
  };

  try {
    printStep(logger, 1, stepTotal, 'Packing npm tarball');
    const packResult = await run(NPM_COMMAND, ['pack', '--json'], { cwd, env });
    assertSuccess(packResult, 'npm pack', NPM_COMMAND, ['pack', '--json']);
    const tarballFilename = parsePackFilename(packResult.stdout);
    tarballPath = path.resolve(cwd, tarballFilename);

    printStep(logger, 2, stepTotal, 'Creating isolated user environment');
    await (options.mkdirFn ?? mkdir)(dirs.homeDir, { recursive: true });
    await (options.mkdirFn ?? mkdir)(dirs.workspaceDir, { recursive: true });
    await (options.mkdirFn ?? mkdir)(dirs.configDir, { recursive: true });
    await (options.mkdirFn ?? mkdir)(dirs.prefixDir, { recursive: true });
    await (options.mkdirFn ?? mkdir)(dirs.npmCacheDir, { recursive: true });
    if (process.platform !== 'win32') {
      await (options.mkdirFn ?? mkdir)(dirs.globalBinDir, { recursive: true });
    }

    const isolatedEnv = buildIsolatedEnv(env, dirs);

    printStep(logger, 3, stepTotal, 'Installing tarball globally in isolated prefix');
    const installResult = await run(NPM_COMMAND, ['install', '--global', tarballPath], { cwd, env: isolatedEnv });
    assertSuccess(installResult, 'npm install -g', NPM_COMMAND, ['install', '--global', tarballPath]);

    const globalBinCandidates =
      process.platform === 'win32'
        ? [dirs.prefixDir, path.join(dirs.prefixDir, 'bin')]
        : [path.join(dirs.prefixDir, 'bin'), dirs.prefixDir];
    const runtimeEnv = setEnvPathValue(
      isolatedEnv,
      `${globalBinCandidates.join(delimiter)}${delimiter}${getEnvPathValue(isolatedEnv)}`
    );

    printStep(logger, 4, stepTotal, 'Running fresh-process status check');
    const statusResult = await run(XYTE_COMMAND, ['status', '--mode', 'fast', '--output', 'json'], {
      cwd,
      env: runtimeEnv
    });
    assertSuccess(statusResult, 'xyte-cli status', XYTE_COMMAND, ['status', '--mode', 'fast', '--output', 'json']);
    const statusPayload = normalizeJsonOutput(statusResult.stdout);
    if (statusPayload.schemaVersion !== 'xyte.status.v1' || statusPayload.mode !== 'fast') {
      throw new Error(`Status check did not return the expected payload: ${JSON.stringify(statusPayload)}`);
    }

    printStep(logger, 5, stepTotal, 'Installing skills as new user and validating copied files');
    const skillsInstallResult = await run(
      XYTE_COMMAND,
      ['init', '--scope', 'both', '--agents', 'all', '--target', dirs.workspaceDir, '--force', '--no-setup'],
      { cwd, env: runtimeEnv }
    );
    assertSuccess(
      skillsInstallResult,
      'xyte-cli init',
      XYTE_COMMAND,
      ['init', '--scope', 'both', '--agents', 'all', '--target', dirs.workspaceDir, '--force', '--no-setup']
    );

    const requiredSkillFiles = [
      path.join(dirs.workspaceDir, '.claude', 'skills', 'xyte-cli', 'SKILL.md'),
      path.join(dirs.workspaceDir, '.github', 'skills', 'xyte-cli', 'SKILL.md'),
      path.join(dirs.workspaceDir, '.agents', 'skills', 'xyte-cli', 'SKILL.md'),
      path.join(dirs.homeDir, '.claude', 'skills', 'xyte-cli', 'SKILL.md'),
      path.join(dirs.homeDir, '.copilot', 'skills', 'xyte-cli', 'SKILL.md'),
      path.join(dirs.homeDir, '.agents', 'skills', 'xyte-cli', 'SKILL.md')
    ];
    for (const skillFile of requiredSkillFiles) {
      if (!(await pathExistsFn(skillFile))) {
        throw new Error(`Skills install verification failed. Missing file: ${skillFile}`);
      }
    }
    const skillManifestResult = await run(NODE_COMMAND, ['-e', SKILL_MANIFEST_VALIDATION_SCRIPT], {
      cwd,
      env: {
        ...runtimeEnv,
        XYTE_SMOKE_WORKSPACE: dirs.workspaceDir,
        XYTE_SMOKE_HOME: dirs.homeDir
      }
    });
    assertSuccess(skillManifestResult, 'xyte-cli skill manifest usability check', NODE_COMMAND, ['-e', 'skill manifest actionable check']);

    printStep(logger, 6, stepTotal, 'Running first-time setup with real key');
    const setupResult = await run(
      XYTE_COMMAND,
      ['setup', 'run', '--non-interactive', '--tenant', tenant, '--key-stdin'],
      {
        cwd,
        env: runtimeEnv,
        input: `${key}\n`
      }
    );
    assertSuccess(
      setupResult,
      'xyte-cli setup run',
      XYTE_COMMAND,
      ['setup', 'run', '--non-interactive', '--tenant', tenant, '--key-stdin']
    );

    printStep(logger, 7, stepTotal, 'Validating persisted key reuse from second process');
    const setupStatusResult = await run(XYTE_COMMAND, ['setup', 'status', '--tenant', tenant, '--output', 'json'], {
      cwd,
      env: runtimeEnv
    });
    assertSuccess(setupStatusResult, 'xyte-cli setup status', XYTE_COMMAND, ['setup', 'status', '--tenant', tenant, '--output', 'json']);
    const setupStatusPayload = normalizeJsonOutput(setupStatusResult.stdout);
    if (setupStatusPayload.state !== 'ready') {
      throw new Error(`Setup status is not ready after setup run: ${JSON.stringify(setupStatusPayload)}`);
    }

    printStep(logger, 8, stepTotal, 'Running real read endpoint call and asserting envelope');
    const callResult = await run(
      XYTE_COMMAND,
      ['api', 'call', 'organization.devices.getDevices', '--tenant', tenant, '--output-mode', 'envelope', '--strict-json'],
      { cwd, env: runtimeEnv }
    );
    assertSuccess(
      callResult,
      'xyte-cli api call organization.devices.getDevices',
      XYTE_COMMAND,
      ['api', 'call', 'organization.devices.getDevices', '--tenant', tenant, '--output-mode', 'envelope', '--strict-json']
    );
    const callPayload = normalizeJsonOutput(callResult.stdout);
    if (callPayload.schemaVersion !== 'xyte.call.envelope.v1') {
      throw new Error(`Unexpected envelope schema version: ${callPayload.schemaVersion}`);
    }
    if (!callPayload.response || typeof callPayload.response.status !== 'number' || callPayload.response.status < 200 || callPayload.response.status >= 300) {
      throw new Error(`Live endpoint call failed or returned non-2xx status: ${JSON.stringify(callPayload.response)}`);
    }

    logger.log(`Smoke passed for tenant "${tenant}" using isolated prefix "${dirs.prefixDir}".`);
  } finally {
    await (options.rmFn ?? rm)(tempRoot, { recursive: true, force: true });
    if (tarballPath) {
      try {
        await (options.unlinkFn ?? unlink)(tarballPath);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

export async function main(): Promise<void> {
  await runExternalUserLiveSmoke();
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
