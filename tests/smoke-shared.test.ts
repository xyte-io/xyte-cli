import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runCommand } from '../src/smoke/shared';

describe('smoke shared runner', () => {
  const itWindows = process.platform === 'win32' ? it : it.skip;

  itWindows('preserves spaced arguments through a real cmd shim round-trip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xyte-cli-cmd-roundtrip-'));
    const collectorPath = join(dir, 'collect-argv.cjs');
    const shimPath = join(dir, 'collect-argv.cmd');
    const outputPath = join(dir, 'argv.json');

    writeFileSync(
      collectorPath,
      [
        'const fs = require("node:fs");',
        'fs.writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)), "utf8");'
      ].join('\n'),
      'utf8'
    );
    writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "%~dp0collect-argv.cjs" %*\r\n`, 'utf8');

    try {
      const result = await runCommand(
        shimPath,
        [outputPath, 'config', 'tenant', 'add', 'acme', '--name', 'Acme Mock', '--hub-url', 'http://127.0.0.1:43123'],
        { stdinMode: 'ignore' }
      );

      expect(result.code).toBe(0);
      expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual([
        'config',
        'tenant',
        'add',
        'acme',
        '--name',
        'Acme Mock',
        '--hub-url',
        'http://127.0.0.1:43123'
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
