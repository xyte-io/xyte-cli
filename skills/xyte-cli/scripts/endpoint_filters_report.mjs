#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bundledSpecPath = path.join(scriptDir, '..', 'data', 'public-endpoints.json');
const command = process.env.XYTE_CLI_BIN?.trim() || (process.platform === 'win32' ? 'xyte-cli.cmd' : 'xyte-cli');

function loadEndpointSpecs() {
  const cliResult = spawnSync(command, ['api', 'endpoints', 'list', '--output', 'json'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8'
  });
  if (!cliResult.error && cliResult.status === 0) {
    try {
      return JSON.parse(cliResult.stdout);
    } catch {
      // fall back to bundled snapshot
    }
  }

  if (!fs.existsSync(bundledSpecPath)) {
    process.stderr.write(`Bundled endpoint spec not found: ${bundledSpecPath}\n`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(bundledSpecPath, 'utf8'));
}

const rows = loadEndpointSpecs()
  .filter((item) => Array.isArray(item.queryParams) && item.queryParams.length > 0)
  .map((item) => ({
    key: item.key,
    method: item.method,
    query: item.queryParams.join(', '),
    pagination: item.queryParams.includes('page') || item.queryParams.includes('per_page') ? 'page/per_page' : 'none'
  }));

process.stdout.write('key | method | query_params | pagination\n');
process.stdout.write('--- | --- | --- | ---\n');
for (const row of rows) {
  process.stdout.write(`${row.key} | ${row.method} | ${row.query} | ${row.pagination}\n`);
}
