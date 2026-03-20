import { describe, expect, it } from 'vitest';

import { buildIsolatedEnv } from '../src/smoke/shared';
import { getEnvPathKey, getEnvPathValue, setEnvPathValue } from '../src/utils/env-path';

describe('env path helpers', () => {
  it('preserves the existing Windows Path key casing when rewriting PATH', () => {
    const env = {
      Path: 'C:\\Windows\\System32',
      PATHEXT: '.EXE;.CMD'
    };

    const next = setEnvPathValue(env, 'C:\\bin;C:\\Windows\\System32', 'win32');

    expect(next.Path).toBe('C:\\bin;C:\\Windows\\System32');
    expect(next.PATH).toBeUndefined();
    expect(getEnvPathKey(next, 'win32')).toBe('Path');
    expect(getEnvPathValue(next, 'win32')).toBe('C:\\bin;C:\\Windows\\System32');
  });

  it('builds isolated environments without dropping a Windows Path entry', () => {
    const isolated = buildIsolatedEnv(
      {
        Path: 'C:\\Windows\\System32'
      },
      {
        homeDir: 'C:\\Users\\runner',
        configDir: 'C:\\Users\\runner\\.config\\xyte',
        prefixDir: 'C:\\Users\\runner\\npm-prefix',
        npmCacheDir: 'C:\\Users\\runner\\npm-cache'
      },
      'win32'
    );

    expect(isolated.Path).toBe('C:\\Windows\\System32');
    expect(isolated.PATH).toBeUndefined();
  });
});
