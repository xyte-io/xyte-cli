#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const validator = path.join(scriptDir, 'validate_with_schema.js');
const headlessCheck = path.join(scriptDir, 'check_headless.mjs');
const schemasDir = path.join(scriptDir, '..', 'schemas');
const command = process.env.XYTE_CLI_BIN?.trim() || (process.platform === 'win32' ? 'xyte-cli.cmd' : 'xyte-cli');
const tenantId = process.argv[2]?.trim() || '';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function runCli(args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    encoding: 'utf8'
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function runNodeScript(scriptPath, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8'
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function parseJson(raw) {
  const trimmed = String(raw).trim();
  if (!trimmed) {
    fail('Expected JSON output but got empty stdout.');
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
  fail(`Unable to parse JSON output:\n${trimmed}`);
}

if (!tenantId) {
  fail(`Usage: ${path.basename(process.argv[1])} <tenant-id>`);
}
if (!fs.existsSync(validator)) {
  fail(`Missing validator script: ${validator}`);
}
if (!fs.existsSync(schemasDir)) {
  fail(`Missing schemas directory: ${schemasDir}`);
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xyte-contracts-'));

try {
  process.stdout.write('Validating call envelope contract...\n');
  const callResult = runCli(['api', 'call', 'organization.devices.getDevices', '--tenant', tenantId, '--output-mode', 'envelope']);
  const callPayload = parseJson(callResult.stdout);
  if (callPayload.schemaVersion !== 'xyte.call.envelope.v1' || typeof callPayload.requestId !== 'string') {
    fail(`FAIL call envelope payload unexpected: ${JSON.stringify(callPayload)}`);
  }
  const callPath = path.join(tmpRoot, 'call-envelope.json');
  fs.writeFileSync(callPath, `${JSON.stringify(callPayload, null, 2)}\n`, 'utf8');
  const callValidation = runNodeScript(validator, [path.join(schemasDir, 'call-envelope.v1.schema.json'), callPath]);
  if (callValidation.status !== 0) {
    fail(`FAIL call envelope schema validation failed\n${callValidation.stderr}`);
  }
  process.stdout.write(`PASS call envelope (exit=${callResult.status ?? 1})\n`);

  process.stdout.write('Validating inspect fleet contract...\n');
  const fleetResult = runCli(['ops', 'inspect', 'fleet', '--tenant', tenantId, '--output', 'json']);
  const fleetPayload = parseJson(fleetResult.stdout);
  if (fleetPayload.schemaVersion !== 'xyte.inspect.fleet.v1') {
    fail(`FAIL inspect fleet schemaVersion=${fleetPayload.schemaVersion}`);
  }
  const fleetPath = path.join(tmpRoot, 'fleet.json');
  fs.writeFileSync(fleetPath, `${JSON.stringify(fleetPayload, null, 2)}\n`, 'utf8');
  const fleetValidation = runNodeScript(validator, [path.join(schemasDir, 'inspect-fleet.v1.schema.json'), fleetPath]);
  if (fleetValidation.status !== 0) {
    fail(`FAIL inspect fleet schema validation failed\n${fleetValidation.stderr}`);
  }
  process.stdout.write('PASS inspect fleet\n');

  process.stdout.write('Validating inspect deep-dive + report contracts...\n');
  const deepPath = path.join(tmpRoot, 'deep-dive.json');
  const deepResult = runCli(['ops', 'inspect', 'deep-dive', '--tenant', tenantId, '--output', 'json', '--out', deepPath]);
  const deepPayload = parseJson(deepResult.stdout);
  if (deepPayload.schemaVersion !== 'xyte.inspect.deep-dive.v1') {
    fail(`FAIL inspect deep-dive schemaVersion=${deepPayload.schemaVersion}`);
  }
  const deepValidation = runNodeScript(validator, [path.join(schemasDir, 'inspect-deep-dive.v1.schema.json'), deepPath]);
  if (deepValidation.status !== 0) {
    fail(`FAIL deep-dive schema validation failed\n${deepValidation.stderr}`);
  }

  const reportPath = path.join(tmpRoot, 'report.md');
  const reportMetaPath = path.join(tmpRoot, 'report-meta.json');
  const reportResult = runCli(['ops', 'report', 'generate', '--tenant', tenantId, '--input', deepPath, '--out', reportPath, '--render', 'markdown']);
  const reportPayload = parseJson(reportResult.stdout);
  if (reportPayload.schemaVersion !== 'xyte.report.v1') {
    fail(`FAIL report schemaVersion=${reportPayload.schemaVersion}`);
  }
  fs.writeFileSync(reportMetaPath, `${JSON.stringify(reportPayload, null, 2)}\n`, 'utf8');
  const reportValidation = runNodeScript(validator, [path.join(schemasDir, 'report.v1.schema.json'), reportMetaPath]);
  if (reportValidation.status !== 0) {
    fail(`FAIL report schema validation failed\n${reportValidation.stderr}`);
  }
  if (!fs.existsSync(reportPath) || fs.statSync(reportPath).size === 0) {
    fail('FAIL report generation produced no report artifact');
  }
  process.stdout.write('PASS report generation\n');

  process.stdout.write('Validating headless contract...\n');
  const headlessValidation = runNodeScript(headlessCheck, [tenantId]);
  if (headlessValidation.status !== 0) {
    fail(`FAIL headless contract validation failed\n${headlessValidation.stderr}`);
  }
  process.stdout.write(headlessValidation.stdout);

  process.stdout.write('All agent contracts validated.\n');
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
