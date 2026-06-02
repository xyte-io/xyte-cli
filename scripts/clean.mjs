#!/usr/bin/env node

import { rmSync } from 'node:fs';
import path from 'node:path';

const targets = process.argv.slice(2);
const resolvedTargets = targets.length > 0 ? targets : ['dist', 'coverage'];

for (const target of resolvedTargets) {
  rmSync(path.resolve(process.cwd(), target), { recursive: true, force: true });
}
