import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('package metadata', () => {
  it('pins runtime floor and blessed alias', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8')) as {
      engines?: Record<string, string>;
      dependencies?: Record<string, string>;
    };

    expect(pkg.engines?.node).toBe('>=22');
    expect(pkg.dependencies?.blessed).toBe('npm:@unblessed/blessed@1.0.0-alpha.23');
  });
});
