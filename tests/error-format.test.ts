import { describe, expect, it } from 'vitest';

import { parseErrorFormatArg, resolveCliErrorFormat } from '../src/utils/error-format';

describe('error format argv parsing', () => {
  it('parses --error-format <value>', () => {
    expect(parseErrorFormatArg(['inspect', 'fleet', '--error-format', 'json'])).toBe('json');
    expect(parseErrorFormatArg(['inspect', 'fleet', '--error-format', 'text'])).toBe('text');
  });

  it('parses --error-format=<value>', () => {
    expect(parseErrorFormatArg(['inspect', 'fleet', '--error-format=json'])).toBe('json');
    expect(parseErrorFormatArg(['inspect', 'fleet', '--error-format=text'])).toBe('text');
  });

  it('does not confuse other json options for --error-format', () => {
    expect(parseErrorFormatArg(['inspect', 'fleet', '--error-format', 'text', '--format', 'json'])).toBe('text');
  });

  it('prefers explicit CLI value over environment fallback', () => {
    expect(resolveCliErrorFormat(['--error-format', 'text'], 'json')).toBe('text');
    expect(resolveCliErrorFormat(['--error-format=json'], 'text')).toBe('json');
  });

  it('falls back to environment when flag is absent', () => {
    expect(resolveCliErrorFormat(['inspect', 'fleet'], 'json')).toBe('json');
    expect(resolveCliErrorFormat(['inspect', 'fleet'], 'text')).toBe('text');
    expect(resolveCliErrorFormat(['inspect', 'fleet'], undefined)).toBe('text');
  });
});
