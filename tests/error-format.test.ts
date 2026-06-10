import { describe, expect, it } from 'vitest';

import { formatErrorText, parseErrorFormatArg, resolveCliErrorFormat } from '../src/utils/error-format';
import { CliUserError } from '../src/contracts/user-error';

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

describe('formatErrorText', () => {
  it('renders summary, detail, and suggested commands for CliUserError', () => {
    const error = new CliUserError({
      summary: 'Provider auto-detection failed for both org and partner.',
      detail: 'Org: 401; Partner: 401',
      suggestedCommands: ['Verify the API key in the Xyte tenant under Settings -> API Keys', 'xyte-cli setup run']
    });

    expect(formatErrorText(error)).toBe(
      [
        'Provider auto-detection failed for both org and partner.',
        'Org: 401; Partner: 401',
        'Try:',
        '- Verify the API key in the Xyte tenant under Settings -> API Keys',
        '- xyte-cli setup run'
      ].join('\n')
    );
  });

  it('renders only the summary when there is nothing else', () => {
    const error = new CliUserError({ summary: 'Missing provider.' });

    expect(formatErrorText(error)).toBe('Missing provider.');
  });

  it('renders plain errors as their message', () => {
    expect(formatErrorText(new Error('boom'))).toBe('boom');
  });
});
