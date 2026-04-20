import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('skills public-endpoints sync', () => {
  it('skills copy is byte-identical to the source catalog', () => {
    const source = readFileSync(
      resolve(__dirname, '../src/api-catalog/public-endpoints.json')
    );
    const target = readFileSync(
      resolve(__dirname, '../skills/xyte-cli/data/public-endpoints.json')
    );
    expect(target.equals(source)).toBe(true);
  });

  it('does not write success noise to stdout', () => {
    const result = spawnSync(process.execPath, [resolve(__dirname, '../scripts/sync_skills_data.mjs')], {
      encoding: 'utf8'
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
