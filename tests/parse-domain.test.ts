import { describe, expect, it } from 'vitest';

import { parseProvider, parseInspectProviderScope } from '../src/utils/parse-domain';
import { CliUserError } from '../src/contracts/user-error';

describe('parseProvider', () => {
  it('returns valid provider as-is', () => {
    expect(parseProvider('xyte-org')).toBe('xyte-org');
    expect(parseProvider('xyte-partner')).toBe('xyte-partner');
  });

  it('trims whitespace', () => {
    expect(parseProvider('  xyte-org  ')).toBe('xyte-org');
  });

  it('throws CliUserError for invalid provider', () => {
    expect(() => parseProvider('organization')).toThrow(CliUserError);
    expect(() => parseProvider('')).toThrow(CliUserError);
  });
});

describe('parseInspectProviderScope', () => {
  it('returns valid scope values', () => {
    expect(parseInspectProviderScope('organization')).toBe('organization');
    expect(parseInspectProviderScope('partner')).toBe('partner');
    expect(parseInspectProviderScope('auto')).toBe('auto');
  });

  it('defaults to auto when undefined', () => {
    expect(parseInspectProviderScope(undefined)).toBe('auto');
  });

  it('normalizes to lowercase', () => {
    expect(parseInspectProviderScope('AUTO')).toBe('auto');
    expect(parseInspectProviderScope('Organization')).toBe('organization');
  });

  it('throws CliUserError for invalid scope', () => {
    expect(() => parseInspectProviderScope('invalid')).toThrow(CliUserError);
    expect(() => parseInspectProviderScope('both')).toThrow(CliUserError);
  });
});
