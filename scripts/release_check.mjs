#!/usr/bin/env node

import { commandExists, runOrThrow } from './run_command.mjs';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const dockerCommand = process.platform === 'win32' ? 'docker.exe' : 'docker';

async function run(command, args, label) {
  process.stdout.write(`== ${label} ==\n`);
  await runOrThrow(command, args, label, {
    env: process.env
  });
}

await run(npmCommand, ['ci'], 'release check: install');
await run(npmCommand, ['run', 'typecheck'], 'release check: typecheck');
await run(npmCommand, ['test'], 'release check: tests');
await run(npmCommand, ['run', 'build'], 'release check: build');
await run(npmCommand, ['run', 'smoke:pack-install'], 'release check: package install smoke');

if (await commandExists(dockerCommand)) {
  await run(npmCommand, ['run', 'smoke:upgrade:controlled'], 'release check: controlled upgrade smoke');
} else {
  process.stdout.write('== release check: controlled upgrade smoke skipped (docker not found) ==\n');
}

await run(npmCommand, ['audit', '--audit-level=high'], 'release check: security audit (high/critical)');

if ((process.env.XYTE_CLI_KEY ?? '').trim()) {
  await run(npmCommand, ['run', 'smoke:external-live'], 'release check: external live smoke');
} else {
  process.stdout.write('== release check: external live smoke skipped (XYTE_CLI_KEY not set) ==\n');
}
