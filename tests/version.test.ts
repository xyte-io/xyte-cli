import { describe, expect, it } from 'vitest';

import { getCliVersion } from '../src/utils/version';

describe('getCliVersion', () => {
  it('returns a semver-like version string', () => {
    const version = getCliVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns the same value on subsequent calls (cached)', () => {
    const a = getCliVersion();
    const b = getCliVersion();
    expect(a).toBe(b);
  });
});
