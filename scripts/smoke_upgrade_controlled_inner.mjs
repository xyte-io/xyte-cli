#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const XYTE_COMMAND = process.platform === 'win32' ? 'xyte-cli.cmd' : 'xyte-cli';
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const NODE_COMMAND = process.platform === 'win32' ? 'node.exe' : 'node';

function assertDefined(value, message) {
  if (!value || !String(value).trim()) {
    throw new Error(message);
  }
  return String(value).trim();
}

async function run(command, args, env = process.env, cwd = process.cwd()) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function assertSuccess(result, label, command, args) {
  if (result.code === 0) {
    return;
  }
  throw new Error(
    `${label} failed (${result.code}).\n${command} ${args.join(' ')}\nstdout:\n${result.stdout.trim()}\nstderr:\n${result.stderr.trim()}`
  );
}

function assertFailure(result, label, expectedText) {
  if (result.code === 0) {
    throw new Error(`${label} unexpectedly succeeded.`);
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (!combined.includes(expectedText)) {
    throw new Error(`${label} failed, but did not include expected text: ${expectedText}\n${combined}`);
  }
}

function parseJsonOutput(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    throw new Error('Expected JSON output but got empty stdout.');
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        return JSON.parse(lines[index]);
      } catch {
        // continue
      }
    }
  }
  throw new Error(`Unable to parse JSON output:\n${trimmed}`);
}

function parseVersion(raw) {
  const match = String(raw).match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/);
  return match ? match[0] : undefined;
}

function parseVersionFromResult(result) {
  return parseVersion(`${result.stdout}\n${result.stderr}`);
}

async function waitForServerReady(child, timeoutMs = 10_000) {
  const start = Date.now();
  return await new Promise((resolve, reject) => {
    let settled = false;

    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes('mock_xyte_local running')) {
        settled = true;
        cleanup();
        resolve(undefined);
      }
    };

    const onExit = () => {
      if (settled) {
        return;
      }
      cleanup();
      reject(new Error('Mock server exited before becoming ready.'));
    };

    const timer = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        cleanup();
        reject(new Error('Timed out waiting for mock server startup.'));
      }
    }, 100);

    const cleanup = () => {
      clearInterval(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
    };

    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

async function main() {
  const tarballA = assertDefined(process.env.XYTE_SMOKE_TARBALL_A, 'Missing XYTE_SMOKE_TARBALL_A.');
  const tarballB = assertDefined(process.env.XYTE_SMOKE_TARBALL_B, 'Missing XYTE_SMOKE_TARBALL_B.');
  const versionA = assertDefined(process.env.XYTE_SMOKE_VERSION_A, 'Missing XYTE_SMOKE_VERSION_A.');
  const versionB = assertDefined(process.env.XYTE_SMOKE_VERSION_B, 'Missing XYTE_SMOKE_VERSION_B.');

  const root = mkdtempSync(join(tmpdir(), 'xyte-upgrade-controlled-'));
  const homeDir = join(root, 'home');
  const configDir = join(root, 'config');
  const fixturesDir = join(root, 'fixtures');
  const csvPath = join(fixturesDir, 'space-import.csv');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(fixturesDir, { recursive: true });
  writeFileSync(csvPath, 'path,space_type\nHQ/Floor-1/Room-A,room\n', 'utf8');

  const runtimeEnv = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    XYTE_CLI_CONFIG_DIR: configDir
  };

  const mockServer = spawn(
    NODE_COMMAND,
    ['/repo/scripts/mock_xyte_local.mjs', '--host', '127.0.0.1', '--port', '3001', '--strict-auth'],
    {
      env: {
        ...runtimeEnv,
        XYTE_LOCAL_AUTH_TOKEN: 'local-key'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  mockServer.stderr.on('data', (chunk) => {
    process.stderr.write(String(chunk));
  });

  try {
    await waitForServerReady(mockServer);

    const installA = await run(NPM_COMMAND, ['install', '--global', tarballA], runtimeEnv);
    assertSuccess(installA, 'install tarball A', NPM_COMMAND, ['install', '--global', tarballA]);

    const versionBefore = await run(XYTE_COMMAND, ['--version'], runtimeEnv);
    if (parseVersionFromResult(versionBefore) !== versionA) {
      throw new Error(
        `Expected version ${versionA} after A install, got stdout="${versionBefore.stdout.trim()}" stderr="${versionBefore.stderr.trim()}"`
      );
    }

    const installSkills = await run(
      XYTE_COMMAND,
      ['install', '--skills', '--scope', 'user', '--agents', 'all', '--force', '--no-setup'],
      runtimeEnv
    );
    assertSuccess(
      installSkills,
      'xyte-cli install --skills',
      XYTE_COMMAND,
      ['install', '--skills', '--scope', 'user', '--agents', 'all', '--force', '--no-setup']
    );

    const userSkillFiles = [
      join(homeDir, '.claude', 'skills', 'xyte-cli', 'SKILL.md'),
      join(homeDir, '.copilot', 'skills', 'xyte-cli', 'SKILL.md'),
      join(homeDir, '.agents', 'skills', 'xyte-cli', 'SKILL.md')
    ];
    for (const filePath of userSkillFiles) {
      readFileSync(filePath, 'utf8');
    }

    const tenantAdd = await run(
      XYTE_COMMAND,
      ['tenant', 'add', 'local', '--hub-url', 'http://127.0.0.1:3001', '--entry-url', 'http://127.0.0.1:3001'],
      runtimeEnv
    );
    assertSuccess(
      tenantAdd,
      'tenant add',
      XYTE_COMMAND,
      ['tenant', 'add', 'local', '--hub-url', 'http://127.0.0.1:3001', '--entry-url', 'http://127.0.0.1:3001']
    );

    const authAdd = await run(
      XYTE_COMMAND,
      ['auth', 'key', 'add', '--tenant', 'local', '--provider', 'xyte-org', '--name', 'local', '--key', 'local-key', '--set-active'],
      runtimeEnv
    );
    assertSuccess(
      authAdd,
      'auth key add',
      XYTE_COMMAND,
      ['auth', 'key', 'add', '--tenant', 'local', '--provider', 'xyte-org', '--name', 'local', '--key', '<redacted>', '--set-active']
    );

    const readCall = await run(
      XYTE_COMMAND,
      ['call', 'organization.devices.getDevices', '--tenant', 'local', '--output-mode', 'envelope', '--strict-json'],
      runtimeEnv
    );
    assertSuccess(
      readCall,
      'read endpoint call',
      XYTE_COMMAND,
      ['call', 'organization.devices.getDevices', '--tenant', 'local', '--output-mode', 'envelope', '--strict-json']
    );
    const readPayload = parseJsonOutput(readCall.stdout);
    if (readPayload.schemaVersion !== 'xyte.call.envelope.v1' || readPayload.response?.status !== 200) {
      throw new Error(`Unexpected read endpoint payload: ${JSON.stringify(readPayload)}`);
    }

    const blockedWrite = await run(
      XYTE_COMMAND,
      [
        'call',
        'organization.commands.sendCommand',
        '--tenant',
        'local',
        '--path-json',
        '{"device_id":"d1"}',
        '--body-json',
        '{"command":"reboot"}'
      ],
      runtimeEnv
    );
    assertFailure(blockedWrite, 'guarded write without --allow-write', '--allow-write');

    const blockedDelete = await run(
      XYTE_COMMAND,
      [
        'call',
        'organization.commands.cancelCommand',
        '--tenant',
        'local',
        '--allow-write',
        '--path-json',
        '{"device_id":"d1","command_id":"cmd-1"}'
      ],
      runtimeEnv
    );
    assertFailure(blockedDelete, 'destructive call without --confirm', '--confirm');

    const dryRun = await run(
      XYTE_COMMAND,
      ['space', 'import-tree', '--tenant', 'local', '--input', csvPath],
      runtimeEnv
    );
    assertSuccess(dryRun, 'space import-tree dry-run', XYTE_COMMAND, ['space', 'import-tree', '--tenant', 'local', '--input', csvPath]);
    const dryRunPayload = parseJsonOutput(dryRun.stdout);
    if (dryRunPayload.schemaVersion !== 'xyte.utility.batch.v1' || dryRunPayload.mode !== 'dry-run') {
      throw new Error(`Unexpected dry-run payload: ${JSON.stringify(dryRunPayload)}`);
    }

    const upgrade = await run(
      XYTE_COMMAND,
      ['upgrade', '--yes', '--format', 'json'],
      {
        ...runtimeEnv,
        XYTE_CLI_UPGRADE_SPEC: tarballB,
        XYTE_CLI_UPGRADE_TARGET_VERSION: versionB
      }
    );
    assertSuccess(upgrade, 'xyte-cli upgrade', XYTE_COMMAND, ['upgrade', '--yes', '--format', 'json']);
    const upgradePayload = parseJsonOutput(upgrade.stdout);
    if (upgradePayload.schemaVersion !== 'xyte.upgrade.result.v1') {
      throw new Error(`Unexpected upgrade payload schema: ${upgradePayload.schemaVersion}`);
    }

    const versionAfter = await run(XYTE_COMMAND, ['--version'], runtimeEnv);
    if (parseVersionFromResult(versionAfter) !== versionB) {
      throw new Error(
        `Expected version ${versionB} after upgrade, got stdout="${versionAfter.stdout.trim()}" stderr="${versionAfter.stderr.trim()}"`
      );
    }

    for (const filePath of userSkillFiles) {
      readFileSync(filePath, 'utf8');
    }

    process.stdout.write('Controlled upgrade smoke passed.\n');
  } finally {
    mockServer.kill('SIGTERM');
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
