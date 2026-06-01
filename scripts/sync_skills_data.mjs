#!/usr/bin/env node
// Keep skills/xyte-cli/data/public-endpoints.json byte-identical to src/api-catalog/public-endpoints.json.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const source = path.join(root, 'src/api-catalog/public-endpoints.json');
const target = path.join(root, 'skills/xyte-cli/data/public-endpoints.json');

try {
  const raw = readFileSync(source, 'utf8');
  JSON.parse(raw);
} catch (error) {
  console.error(`[sync_skills_data] Source is missing or invalid JSON: ${source}`);
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

mkdirSync(path.dirname(target), { recursive: true });
copyFileSync(source, target);
