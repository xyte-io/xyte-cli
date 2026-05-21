import { describe, expect, it } from 'vitest';

import { getXyteConfigDir } from '../src/utils/config-dir';

describe('getXyteConfigDir', () => {
  it('uses XYTE_CLI_CONFIG_DIR when set', () => {
    const result = getXyteConfigDir({ XYTE_CLI_CONFIG_DIR: '/custom/dir' } as NodeJS.ProcessEnv);
    expect(result).toBe('/custom/dir');
  });

  it('returns a non-empty string for default env', () => {
    const result = getXyteConfigDir({} as NodeJS.ProcessEnv);
    expect(result.length).toBeGreaterThan(0);
    expect(result).toContain('xyte-cli');
  });
});
