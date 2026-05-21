#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const command = process.env.XYTE_CLI_BIN?.trim() || (process.platform === 'win32' ? 'xyte-cli.cmd' : 'xyte-cli');

const result = spawnSync(command, process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit'
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
