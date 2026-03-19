#!/usr/bin/env node

import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const dockerCommand = process.platform === 'win32' ? 'docker.exe' : 'docker';

function run(command, args, label) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`== ${label} ==\n`);
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if ((code ?? 1) !== 0) {
        reject(new Error(`${label} failed with exit code ${code ?? 1}.`));
        return;
      }
      resolve(undefined);
    });
  });
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn(command, ['--version'], {
      stdio: 'ignore'
    });

    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve((code ?? 1) === 0));
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
