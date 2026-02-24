#!/usr/bin/env node

import { mkdtempSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';

const XYTE_COMMAND = process.platform === 'win32' ? 'xyte-cli.cmd' : 'xyte-cli';

function parseArgs(argv) {
  const args = {
    baseUrl: 'http://127.0.0.1:3001',
    tenant: 'local',
    fixturesDir: resolve(process.cwd(), 'scripts/fixtures/utilities')
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--base-url') {
      args.baseUrl = argv[index + 1] ?? args.baseUrl;
      index += 1;
      continue;
    }
    if (token === '--tenant') {
      args.tenant = argv[index + 1] ?? args.tenant;
      index += 1;
      continue;
    }
    if (token === '--fixtures-dir') {
      args.fixturesDir = resolve(argv[index + 1] ?? args.fixturesDir);
      index += 1;
    }
  }

  return args;
}

async function run(command, args, env = process.env) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr
      });
    });
  });
}

function assertOk(result, label, command, args) {
  if (result.code === 0) {
    return;
  }
  const details = [
    `${command} ${args.join(' ')}`,
    result.stdout ? `stdout:\n${result.stdout.trim()}` : '',
    result.stderr ? `stderr:\n${result.stderr.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n\n');
  throw new Error(`${label} failed with exit code ${result.code}.\n${details}`);
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
        // continue scan
      }
    }
  }
  throw new Error(`Unable to parse JSON output: ${trimmed}`);
}

async function resetMock(baseUrl) {
  const response = await fetch(`${baseUrl}/_mock/reset`, {
    method: 'POST'
  });
  if (!response.ok) {
    throw new Error(`Failed to reset mock server (${response.status}).`);
  }
}

async function getMockState(baseUrl) {
  const response = await fetch(`${baseUrl}/_mock/state`);
  if (!response.ok) {
    throw new Error(`Failed to read mock state (${response.status}).`);
  }
  return response.json();
}

function expectSummary(payload, mode) {
  if (payload.schemaVersion !== 'xyte.utility.batch.v1') {
    throw new Error(`Unexpected schemaVersion: ${payload.schemaVersion}`);
  }
  if (payload.mode !== mode) {
    throw new Error(`Expected mode=${mode}, got ${payload.mode}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const configDir = mkdtempSync(join(tmpdir(), 'xyte-local-utility-smoke-'));
  const env = {
    ...process.env,
    XYTE_CLI_CONFIG_DIR: configDir
  };
  const fixtures = {
    space: join(args.fixturesDir, 'space-import.csv')
  };

  readFileSync(fixtures.space, 'utf8');

  await resetMock(args.baseUrl);

  const tenantAdd = ['tenant', 'add', args.tenant, '--hub-url', args.baseUrl, '--entry-url', args.baseUrl];
  assertOk(await run(XYTE_COMMAND, tenantAdd, env), 'tenant add', XYTE_COMMAND, tenantAdd);

  const authAdd = ['auth', 'key', 'add', '--tenant', args.tenant, '--provider', 'xyte-org', '--name', 'local', '--key', 'local-key', '--set-active'];
  assertOk(await run(XYTE_COMMAND, authAdd, env), 'auth key add', XYTE_COMMAND, authAdd);

  const prepareArgs = ['utility', 'prepare', '--action', 'space.import-tree', '--input', fixtures.space, '--output-dir', configDir, '--tenant', args.tenant, '--force'];
  const prepare = await run(XYTE_COMMAND, prepareArgs, env);
  assertOk(prepare, 'utility prepare for space.import-tree', XYTE_COMMAND, prepareArgs);
  const prepareOutput = parseJsonOutput(prepare.stdout);
  if (prepareOutput.schemaVersion !== 'xyte.utility.prepare.v1') {
    throw new Error(`Unexpected prepare schemaVersion: ${prepareOutput.schemaVersion}`);
  }

  const spaceDryArgs = ['space', 'import-tree', '--tenant', args.tenant, '--input', fixtures.space];
  const spaceDry = await run(XYTE_COMMAND, spaceDryArgs, env);
  assertOk(spaceDry, 'space import-tree dry-run', XYTE_COMMAND, spaceDryArgs);
  expectSummary(parseJsonOutput(spaceDry.stdout), 'dry-run');

  const spaceApplyArgs = ['space', 'import-tree', '--tenant', args.tenant, '--input', fixtures.space, '--apply'];
  const spaceApply = await run(XYTE_COMMAND, spaceApplyArgs, env);
  assertOk(spaceApply, 'space import-tree apply', XYTE_COMMAND, spaceApplyArgs);
  expectSummary(parseJsonOutput(spaceApply.stdout), 'apply');

  const spaceApplyAgain = await run(XYTE_COMMAND, spaceApplyArgs, env);
  assertOk(spaceApplyAgain, 'space import-tree apply (idempotent rerun)', XYTE_COMMAND, spaceApplyArgs);
  expectSummary(parseJsonOutput(spaceApplyAgain.stdout), 'apply');

  const state = await getMockState(args.baseUrl);
  const spacesByPath = new Map((state.spaces ?? []).map((item) => [item.full_path, item]));

  if (!spacesByPath.has('HQ/Floor-1/Room-A')) {
    throw new Error('Space import verification failed in mock state.');
  }

  process.stdout.write('Local utility smoke passed.\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
