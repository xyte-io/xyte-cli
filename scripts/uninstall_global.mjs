#!/usr/bin/env node

import { runCommand, runOrThrow } from './run_command.mjs';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const installed = await runCommand(npmCommand, ['ls', '-g', '--depth=0', '@xyteai/cli', '--json'], {
  stdio: ['ignore', 'pipe', 'pipe']
});

if (installed.code !== 0) {
  process.exitCode = 0;
} else {
  await runOrThrow(npmCommand, ['unlink', '-g', '@xyteai/cli'], 'npm unlink -g @xyteai/cli', {
    env: process.env
  });
}
