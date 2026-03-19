import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('package scripts', () => {
  it('enforces packaged-artifact smoke in the local ship gates', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(pkg.bin?.['xyte-cli']).toBe('dist/bin/xyte-cli.js');
    expect(pkg.scripts?.clean).toBe('node scripts/clean.mjs');
    expect(pkg.scripts?.['smoke:pack-install']).toBe('node scripts/smoke_pack_install.mjs');
    expect(pkg.scripts?.['smoke:external-live']).toBe('node scripts/smoke_external_user_live.mjs');
    expect(pkg.scripts?.prepublishOnly).toBe('npm run typecheck && npm test && npm run build && npm run smoke:pack-install');
    expect(pkg.scripts?.['test:commit']).toBe('npm run typecheck && npm test && npm run smoke:pack-install');
    expect(pkg.scripts?.['release:check']).toBe('node scripts/release_check.mjs');
    expect(pkg.scripts?.['release:publish']).toBe('node scripts/publish.mjs all');
  });
});
