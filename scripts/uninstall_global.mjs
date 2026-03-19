#!/usr/bin/env node

import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const result = await new Promise((resolve, reject) => {
  const child = spawn(npmCommand, ['unlink', '-g', '@xyteai/cli'], {
    stdio: 'inherit'
  });

  child.on('error', reject);
  child.on('close', (code) => resolve(code ?? 1));
});

if (typeof result === 'number' && result !== 0) {
  process.exitCode = 0;
}
