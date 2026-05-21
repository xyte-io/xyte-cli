#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const SCREENS = ['setup', 'config', 'dashboard', 'spaces', 'devices', 'incidents', 'tickets'];
const META_KEYS = [
  'inputState',
  'queueDepth',
  'droppedEvents',
  'transitionState',
  'refreshState',
  'navigationMode',
  'activePane',
  'availablePanes',
  'tabId',
  'tabOrder',
  'tabNavBoundary',
  'renderSafety',
  'tableFormat',
  'contract'
];

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(scriptDir, 'validate_with_schema.js');
const schemaPath = path.join(scriptDir, '..', 'schemas', 'headless-frame.v1.schema.json');
const command = process.env.XYTE_CLI_BIN?.trim() || (process.platform === 'win32' ? 'xyte-cli.cmd' : 'xyte-cli');
const tenantId = process.argv[2]?.trim() || '';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function runNodeScript(scriptPath, args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: 'utf8'
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function parseJsonLines(raw) {
  return String(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

if (!fs.existsSync(validator)) {
  fail(`Missing validator script: ${validator}`);
}
if (!fs.existsSync(schemaPath)) {
  fail(`Missing schema file: ${schemaPath}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xyte-headless-'));

try {
  let passCount = 0;

  for (const screen of SCREENS) {
    const screenTmpRoot = fs.mkdtempSync(path.join(tmpRoot, `${screen}-`));
    const env = tenantId ? process.env : { ...process.env, XYTE_CLI_CONFIG_DIR: screenTmpRoot };
    const result = spawnSync(
      command,
      ['ops', 'console', '--headless', '--screen', screen, '--output', 'json', '--once', '--no-motion', ...(tenantId ? ['--tenant', tenantId] : [])],
      {
        cwd: process.cwd(),
        env,
        encoding: 'utf8'
      }
    );
    if (result.error) {
      throw result.error;
    }

    if (result.status !== 0) {
      fail(`FAIL [${screen}] command exited ${result.status}\n${result.stderr}`);
    }

    const runtimeFrame = parseJsonLines(result.stdout).filter((frame) => frame?.meta?.startup !== true).at(-1);
    if (!runtimeFrame) {
      fail(`FAIL [${screen}] no runtime frame`);
    }

    if (runtimeFrame.schemaVersion !== 'xyte.headless.frame.v1') {
      fail(`FAIL [${screen}] unexpected schemaVersion=${runtimeFrame.schemaVersion}`);
    }
    if (typeof runtimeFrame.sessionId !== 'string') {
      fail(`FAIL [${screen}] missing sessionId`);
    }
    if (typeof runtimeFrame.sequence !== 'number') {
      fail(`FAIL [${screen}] missing sequence`);
    }
    for (const key of META_KEYS) {
      if (!(key in (runtimeFrame.meta ?? {}))) {
        fail(`FAIL [${screen}] missing meta.${key}`);
      }
    }
    if (runtimeFrame.meta?.contract?.frameVersion !== 'xyte.headless.frame.v1') {
      fail(`FAIL [${screen}] unexpected contract.frameVersion`);
    }
    if (screen !== 'setup' && screen !== 'config' && runtimeFrame.screen === 'setup') {
      if (runtimeFrame.meta?.redirectedFrom !== screen) {
        fail(`FAIL [${screen}] expected redirectedFrom=${screen}, got ${runtimeFrame.meta?.redirectedFrom ?? ''}`);
      }
    }
    if (!Array.isArray(runtimeFrame.panels)) {
      fail(`FAIL [${screen}] panels is not an array`);
    }

    const runtimePath = path.join(screenTmpRoot, `headless-${screen}.json`);
    fs.writeFileSync(runtimePath, `${JSON.stringify(runtimeFrame, null, 2)}\n`, 'utf8');
    const validation = runNodeScript(validator, [schemaPath, runtimePath]);
    if (validation.status !== 0) {
      fail(`FAIL [${screen}] schema validation failed\n${validation.stderr}`);
    }

    process.stdout.write(`PASS [${screen}] runtime_screen=${runtimeFrame.screen}\n`);
    passCount += 1;
  }

  process.stdout.write(`Headless smoke passed: ${passCount}/${SCREENS.length} screens\n`);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
