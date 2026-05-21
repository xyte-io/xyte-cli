import { describe, expect, it } from 'vitest';

import { parseErrorFormatArg, resolveCliErrorFormat } from '../src/utils/error-format';

describe('error format argv parsing', () => {
  it('parses --error-format <value>', () => {
    expect(parseErrorFormatArg(['ops', 'inspect', 'fleet', '--error-format', 'json'])).toBe('json');
    expect(parseErrorFormatArg(['ops', 'inspect', 'fleet', '--error-format', 'text'])).toBe('text');
  });

  it('parses --error-format=<value>', () => {
    expect(parseErrorFormatArg(['ops', 'inspect', 'fleet', '--error-format=json'])).toBe('json');
    expect(parseErrorFormatArg(['ops', 'inspect', 'fleet', '--error-format=text'])).toBe('text');
  });

  it('does not confuse other json options for --error-format', () => {
    expect(parseErrorFormatArg(['ops', 'inspect', 'fleet', '--error-format', 'text', '--output', 'json'])).toBe('text');
  });

  it('rejects invalid explicit values', () => {
    expect(() => parseErrorFormatArg(['--error-format', 'xml'])).toThrow('Invalid error format');
    expect(() => parseErrorFormatArg(['--error-format=xml'])).toThrow('Invalid error format');
    expect(() => parseErrorFormatArg(['--error-format'])).toThrow('Missing error format value');
  });

  it('prefers explicit CLI value over environment fallback', () => {
    expect(resolveCliErrorFormat(['--error-format', 'text'], 'json')).toBe('text');
    expect(resolveCliErrorFormat(['--error-format=json'], 'text')).toBe('json');
  });

  it('falls back to environment when flag is absent', () => {
    expect(resolveCliErrorFormat(['ops', 'inspect', 'fleet'], 'json')).toBe('json');
    expect(resolveCliErrorFormat(['ops', 'inspect', 'fleet'], 'text')).toBe('text');
    expect(resolveCliErrorFormat(['ops', 'inspect', 'fleet'], undefined)).toBe('text');
  });
});
