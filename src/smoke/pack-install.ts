import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path, { delimiter } from 'node:path';

import { getEnvPathValue, setEnvPathValue } from '../utils/env-path';
import {
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
import { errorMessage } from '../utils/error-format';

interface MockServerHandle {
  baseUrl: string;
  close: () => Promise<void>;
}

export interface PackInstallSmokeOptions {
  cwd?: string;
  logger?: LoggerLike;
  env?: NodeJS.ProcessEnv;
  run?: (command: string, args: string[], options?: RunCommandOptions) => Promise<{ code: number; stdout: string; stderr: string }>;
  pathExistsFn?: typeof pathExists;
  readFileFn?: (path: string, encoding: BufferEncoding) => Promise<string>;
  mkdtempFn?: (prefix: string) => Promise<string>;
  mkdirFn?: (path: string, options?: { recursive?: boolean }) => Promise<unknown>;
  rmFn?: (path: string, options?: { recursive?: boolean; force?: boolean }) => Promise<unknown>;
  unlinkFn?: (path: string) => Promise<unknown>;
  startMockServerFn?: (options?: { cwd?: string; env?: NodeJS.ProcessEnv; authToken?: string }) => Promise<MockServerHandle>;
}

async function reserveFreePort(host = '127.0.0.1'): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Could not determine a free TCP port for the mock backend.')));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

async function waitForMockServerReady(child: ReturnType<typeof spawn>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    let settled = false;

    const onData = (chunk: Buffer | string) => {
      const text = String(chunk);
      if (text.includes('mock_xyte_local running')) {
        settled = true;
        cleanup();
        resolve();
      }
    };

    const onExit = () => {
      if (settled) {
        return;
      }
      cleanup();
      reject(new Error('Mock backend exited before it became ready.'));
    };

    const timer = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        cleanup();
        reject(new Error('Timed out waiting for the mock backend to start.'));
      }
    }, 100);

    const cleanup = () => {
      clearInterval(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout?.on('data', onData);
    child.on('exit', onExit);
  });
}

async function stopMockServer(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 5_000);

    child.once('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });

    child.kill('SIGTERM');
  });
}

async function startMockServer(options: { cwd?: string; env?: NodeJS.ProcessEnv; authToken?: string } = {}): Promise<MockServerHandle> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const port = await reserveFreePort();
  const mockScriptPath = path.resolve(cwd, 'scripts', 'mock_xyte_local.mjs');
  const child = spawn(process.execPath, [mockScriptPath, '--host', '127.0.0.1', '--port', String(port), '--strict-auth'], {
    cwd,
    env: {
      ...env,
      XYTE_LOCAL_AUTH_TOKEN: options.authToken ?? 'smoke-test-key'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitForMockServerReady(child);
  } catch (error) {
    await stopMockServer(child);
    const details = stderr.trim();
    throw new Error(details ? `${errorMessage(error)}\n${details}` : String(error));
  }

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    async close() {
      await stopMockServer(child);
    }
  };
}

export async function runPackInstallSmoke(options: PackInstallSmokeOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const logger = options.logger ?? console;
  const env = options.env ?? process.env;
  const run = options.run ?? runCommand;
  const pathExistsFn = options.pathExistsFn ?? pathExists;
  const readFileFn = options.readFileFn ?? readFile;
  const startMockServerFn = options.startMockServerFn ?? startMockServer;

  const stepTotal = 13;
  let tarballPath: string | undefined;
  let mockServer: MockServerHandle | undefined;
  const tempRoot = await (options.mkdtempFn ?? mkdtemp)(path.join(tmpdir(), 'xyte-cli-pack-install-'));
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
    const runtimeCwd = dirs.workspaceDir;

    printStep(logger, 4, stepTotal, 'Checking help and install doctor');
    const helpResult = await run(XYTE_COMMAND, ['--help'], { cwd: runtimeCwd, env: runtimeEnv });
    assertSuccess(helpResult, 'xyte-cli --help', XYTE_COMMAND, ['--help']);
    const doctorResult = await run(XYTE_COMMAND, ['doctor', 'install', '--format', 'json'], {
      cwd: runtimeCwd,
      env: runtimeEnv
    });
    assertSuccess(doctorResult, 'xyte-cli doctor install', XYTE_COMMAND, ['doctor', 'install', '--format', 'json']);
    const doctorPayload = normalizeJsonOutput(doctorResult.stdout) as Record<string, unknown>;
    if (doctorPayload.sameTarget !== true || doctorPayload.status !== 'ok') {
      throw new Error(`Install doctor did not report the packaged binary as active: ${JSON.stringify(doctorPayload)}`);
    }

    printStep(logger, 5, stepTotal, 'Running fresh-process status check');
    const statusResult = await run(XYTE_COMMAND, ['status', '--mode', 'fast', '--output', 'json'], {
      cwd: runtimeCwd,
      env: runtimeEnv
    });
    assertSuccess(statusResult, 'xyte-cli status', XYTE_COMMAND, ['status', '--mode', 'fast', '--output', 'json']);
    const statusPayload = normalizeJsonOutput(statusResult.stdout) as Record<string, unknown>;
    if (statusPayload.schemaVersion !== 'xyte.status.v1' || statusPayload.mode !== 'fast') {
      throw new Error(`Status check did not return the expected payload: ${JSON.stringify(statusPayload)}`);
    }

    printStep(logger, 6, stepTotal, 'Running first-time init without credentials');
    const initResult = await run(
      XYTE_COMMAND,
      ['init', '--scope', 'both', '--agents', 'all', '--target', dirs.workspaceDir, '--force'],
      { cwd: runtimeCwd, env: runtimeEnv }
    );
    assertSuccess(initResult, 'xyte-cli init', XYTE_COMMAND, ['init', '--scope', 'both', '--agents', 'all', '--target', dirs.workspaceDir, '--force']);

    const requiredSkillRoots = [
      path.join(dirs.workspaceDir, '.claude', 'skills', 'xyte-cli'),
      path.join(dirs.workspaceDir, '.github', 'skills', 'xyte-cli'),
      path.join(dirs.workspaceDir, '.agents', 'skills', 'xyte-cli'),
      path.join(dirs.homeDir, '.claude', 'skills', 'xyte-cli'),
      path.join(dirs.homeDir, '.copilot', 'skills', 'xyte-cli'),
      path.join(dirs.homeDir, '.agents', 'skills', 'xyte-cli')
    ];
    const requiredSkillFiles = requiredSkillRoots.flatMap((root) => [
      path.join(root, 'SKILL.md'),
      path.join(root, 'agents', 'openai.yaml'),
      path.join(root, 'references', 'ai-utility-preprocessing.md'),
      path.join(root, 'references', 'flow-recipes.md'),
      path.join(root, 'scripts', 'check_headless.mjs'),
      path.join(root, 'templates', 'ai-utility-prepare-generic.prompt.md'),
      path.join(root, 'templates', 'ai-space-import.prompt.md'),
      path.join(root, 'schemas', 'headless-frame.v1.schema.json'),
      path.join(root, 'data', 'public-endpoints.json')
    ]);
    for (const skillFile of requiredSkillFiles) {
      if (!(await pathExistsFn(skillFile))) {
        throw new Error(`Skills install verification failed. Missing file: ${skillFile}`);
      }
    }

    printStep(logger, 7, stepTotal, 'Running shell-neutral setup via stdin');
    const setupResult = await run(
      XYTE_COMMAND,
      ['setup', 'run', '--non-interactive', '--tenant', 'acme', '--key-stdin', '--connectivity', 'never', '--output', 'json'],
      {
        cwd: runtimeCwd,
        env: runtimeEnv,
        input: 'smoke-test-key\n'
      }
    );
    assertSuccess(
      setupResult,
      'xyte-cli setup run',
      XYTE_COMMAND,
      ['setup', 'run', '--non-interactive', '--tenant', 'acme', '--key-stdin', '--connectivity', 'never', '--output', 'json']
    );
    const setupPayload = normalizeJsonOutput(setupResult.stdout) as Record<string, unknown>;
    const setupReadiness = setupPayload.readiness as Record<string, unknown> | undefined;
    if (setupPayload.tenantId !== 'acme' || setupReadiness?.tenantId !== 'acme') {
      throw new Error(`Setup run did not return the expected tenant payload: ${JSON.stringify(setupPayload)}`);
    }

    printStep(logger, 8, stepTotal, 'Checking setup field extraction');
    const fieldResult = await run(XYTE_COMMAND, ['setup', 'status', '--tenant', 'acme', '--field', 'tenantId'], {
      cwd: runtimeCwd,
      env: runtimeEnv
    });
    assertSuccess(fieldResult, 'xyte-cli setup status --field tenantId', XYTE_COMMAND, ['setup', 'status', '--tenant', 'acme', '--field', 'tenantId']);
    if (String(fieldResult.stdout).trim() !== 'acme') {
      throw new Error(`Field extraction returned an unexpected value: ${fieldResult.stdout}`);
    }

    printStep(logger, 9, stepTotal, 'Pointing the configured tenant at a local mock backend');
    mockServer = await startMockServerFn({
      cwd,
      env: runtimeEnv,
      authToken: 'smoke-test-key'
    });
    const tenantConfigResult = await run(
      XYTE_COMMAND,
      ['config', 'tenant', 'add', 'acme', '--name', 'Acme Mock', '--hub-url', mockServer.baseUrl, '--entry-url', mockServer.baseUrl],
      { cwd: runtimeCwd, env: runtimeEnv }
    );
    assertSuccess(
      tenantConfigResult,
      'xyte-cli config tenant add',
      XYTE_COMMAND,
      ['config', 'tenant', 'add', 'acme', '--name', 'Acme Mock', '--hub-url', mockServer.baseUrl, '--entry-url', mockServer.baseUrl]
    );

    printStep(logger, 10, stepTotal, 'Checking watch --out with nested NDJSON output');
    const watchPath = path.join(dirs.workspaceDir, 'artifacts', 'xyte-watch.incidents.ndjson');
    const watchResult = await run(
      XYTE_COMMAND,
      ['ops', 'watch', 'incidents', '--tenant', 'acme', '--profile', 'incidents-active', '--once', '--output', 'json', '--strict-json', '--out', watchPath],
      { cwd: runtimeCwd, env: runtimeEnv }
    );
    assertSuccess(
      watchResult,
      'xyte-cli ops watch incidents',
      XYTE_COMMAND,
      ['ops', 'watch', 'incidents', '--tenant', 'acme', '--profile', 'incidents-active', '--once', '--output', 'json', '--strict-json', '--out', watchPath]
    );
    if (!(await pathExistsFn(watchPath))) {
      throw new Error(`Watch command did not create the nested output path: ${watchPath}`);
    }
    const watchContents = await readFileFn(watchPath, 'utf8');
    const firstWatchFrame = String(watchContents)
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean);
    if (!firstWatchFrame) {
      throw new Error(`Watch command produced an empty NDJSON artifact at ${watchPath}`);
    }
    const watchPayload = JSON.parse(firstWatchFrame);
    if (watchPayload.schemaVersion !== 'xyte.watch.frame.v1') {
      throw new Error(`Watch command wrote an unexpected payload: ${JSON.stringify(watchPayload)}`);
    }

    printStep(logger, 11, stepTotal, 'Checking inspect fleet --out with nested JSON output');
    const fleetPath = path.join(dirs.workspaceDir, 'artifacts', 'xyte-fleet.json');
    const fleetResult = await run(XYTE_COMMAND, ['ops', 'inspect', 'fleet', '--tenant', 'acme', '--output', 'json', '--out', fleetPath], {
      cwd: runtimeCwd,
      env: runtimeEnv
    });
    assertSuccess(fleetResult, 'xyte-cli ops inspect fleet', XYTE_COMMAND, ['ops', 'inspect', 'fleet', '--tenant', 'acme', '--output', 'json', '--out', fleetPath]);
    if (!(await pathExistsFn(fleetPath))) {
      throw new Error(`Fleet inspect did not create the nested output path: ${fleetPath}`);
    }
    const fleetPayload = normalizeJsonOutput(await readFileFn(fleetPath, 'utf8')) as Record<string, unknown>;
    if (fleetPayload.schemaVersion !== 'xyte.inspect.fleet.v1') {
      throw new Error(`Fleet inspect wrote an unexpected payload: ${JSON.stringify(fleetPayload)}`);
    }

    printStep(logger, 12, stepTotal, 'Checking inspect deep-dive --out with nested JSON output');
    const deepDivePath = path.join(dirs.workspaceDir, 'artifacts', 'xyte-deep-dive.json');
    const deepDiveResult = await run(
      XYTE_COMMAND,
      ['ops', 'inspect', 'deep-dive', '--tenant', 'acme', '--window', '24', '--output', 'json', '--out', deepDivePath],
      { cwd: runtimeCwd, env: runtimeEnv }
    );
    assertSuccess(
      deepDiveResult,
      'xyte-cli ops inspect deep-dive',
      XYTE_COMMAND,
      ['ops', 'inspect', 'deep-dive', '--tenant', 'acme', '--window', '24', '--output', 'json', '--out', deepDivePath]
    );
    if (!(await pathExistsFn(deepDivePath))) {
      throw new Error(`Deep-dive inspect did not create the nested output path: ${deepDivePath}`);
    }
    const deepDivePayload = normalizeJsonOutput(await readFileFn(deepDivePath, 'utf8')) as Record<string, unknown>;
    if (deepDivePayload.schemaVersion !== 'xyte.inspect.deep-dive.v1') {
      throw new Error(`Deep-dive inspect wrote an unexpected payload: ${JSON.stringify(deepDivePayload)}`);
    }

    printStep(logger, 13, stepTotal, 'Checking report generation from inspect --out artifacts');
    const reportPath = path.join(dirs.workspaceDir, 'reports', 'fleet-report.md');
    const reportResult = await run(
      XYTE_COMMAND,
      ['ops', 'report', 'generate', '--tenant', 'acme', '--input', deepDivePath, '--out', reportPath, '--render', 'markdown'],
      { cwd: runtimeCwd, env: runtimeEnv }
    );
    assertSuccess(
      reportResult,
      'xyte-cli ops report generate',
      XYTE_COMMAND,
      ['ops', 'report', 'generate', '--tenant', 'acme', '--input', deepDivePath, '--out', reportPath, '--render', 'markdown']
    );
    if (!(await pathExistsFn(reportPath))) {
      throw new Error(`Report generation did not create the nested output path: ${reportPath}`);
    }
    const reportContents = await readFileFn(reportPath, 'utf8');
    if (!String(reportContents).trim()) {
      throw new Error(`Report generation produced an empty report artifact at ${reportPath}`);
    }

    logger.log(`Pack-install smoke passed using isolated prefix "${dirs.prefixDir}".`);
  } finally {
    if (mockServer) {
      await mockServer.close();
    }
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
  await runPackInstallSmoke();
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
