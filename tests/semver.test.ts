import { describe, expect, it } from 'vitest';

import { compareSemver } from '../src/utils/semver';

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('0.1.0', '0.1.0')).toBe(0);
  });

  it('compares major versions', () => {
    expect(compareSemver('2.0.0', '1.0.0')).toBe(1);
    expect(compareSemver('1.0.0', '2.0.0')).toBe(-1);
  });

  it('compares minor versions', () => {
    expect(compareSemver('1.2.0', '1.1.0')).toBe(1);
    expect(compareSemver('1.0.0', '1.1.0')).toBe(-1);
  });

  it('compares patch versions', () => {
    expect(compareSemver('1.0.2', '1.0.1')).toBe(1);
    expect(compareSemver('1.0.0', '1.0.1')).toBe(-1);
  });

  it('prerelease is lower than release', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0')).toBe(-1);
    expect(compareSemver('1.0.0', '1.0.0-beta')).toBe(1);
  });

  it('compares prerelease identifiers', () => {
    expect(compareSemver('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(compareSemver('1.0.0-beta', '1.0.0-alpha')).toBe(1);
  });

  it('compares numeric prerelease identifiers', () => {
    expect(compareSemver('1.0.0-1', '1.0.0-2')).toBe(-1);
    expect(compareSemver('1.0.0-10', '1.0.0-2')).toBe(1);
  });

  it('numeric prerelease sorts before string prerelease', () => {
    expect(compareSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareSemver('1.0.0-alpha', '1.0.0-1')).toBe(1);
  });

  it('falls back to string comparison for non-semver inputs', () => {
    expect(compareSemver('abc', 'abc')).toBe(0);
    expect(compareSemver('abc', 'def')).toBe(-1);
    expect(compareSemver('def', 'abc')).toBe(1);
  });

  it('handles whitespace trimming', () => {
    expect(compareSemver(' 1.0.0 ', '1.0.0')).toBe(0);
  });

  it('equal prerelease versions return 0', () => {
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.1')).toBe(0);
  });

  it('longer prerelease is greater when prefix matches', () => {
    expect(compareSemver('1.0.0-alpha.1.2', '1.0.0-alpha.1')).toBe(1);
    expect(compareSemver('1.0.0-alpha.1', '1.0.0-alpha.1.2')).toBe(-1);
  });
});
