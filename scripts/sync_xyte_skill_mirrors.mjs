#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();
const sourceDir = path.join(repoRoot, 'skills', 'xyte-cli');
const targets = [
  path.join(repoRoot, '.github', 'skills', 'xyte-cli'),
  path.join(repoRoot, '.agents', 'skills', 'xyte-cli')
];

if (!fs.existsSync(sourceDir)) {
  process.stderr.write(`Canonical skill tree not found: ${sourceDir}\n`);
  process.exit(1);
}

for (const target of targets) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(sourceDir, target, { recursive: true });
  process.stdout.write(`Synced ${sourceDir} -> ${target}\n`);
}
