import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}
