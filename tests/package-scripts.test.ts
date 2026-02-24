import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('package scripts', () => {
  it('enforces the commit gate chain with live external smoke', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(pkg.scripts?.['smoke:external-live']).toBe('node scripts/smoke_external_user_live.mjs');
    expect(pkg.scripts?.['test:commit']).toBe('npm run typecheck && npm test && npm run smoke:external-live');
  });
});
