import { describe, expect, it } from 'vitest';

import { CliUserError, isCliUserError } from '../../src/contracts/user-error';

describe('CliUserError', () => {
  it('sets summary as message', () => {
    const err = new CliUserError({ summary: 'Something went wrong' });
    expect(err.message).toBe('Something went wrong');
    expect(err.summary).toBe('Something went wrong');
  });

  it('defaults suggestedCommands to empty array', () => {
    const err = new CliUserError({ summary: 'Error' });
    expect(err.suggestedCommands).toEqual([]);
  });

  it('defaults xyteCode to XYTE_CLI_USER_ERROR', () => {
    const err = new CliUserError({ summary: 'Error' });
    expect(err.xyteCode).toBe('XYTE_CLI_USER_ERROR');
  });

  it('sets optional detail', () => {
    const err = new CliUserError({ summary: 'Error', detail: 'More context' });
    expect(err.detail).toBe('More context');
  });

  it('sets suggestedCommands when provided', () => {
    const err = new CliUserError({ summary: 'Error', suggestedCommands: ['xyte config set'] });
    expect(err.suggestedCommands).toEqual(['xyte config set']);
  });

  it('sets custom xyteCode when provided', () => {
    const err = new CliUserError({ summary: 'Error', xyteCode: 'CUSTOM_CODE' });
    expect(err.xyteCode).toBe('CUSTOM_CODE');
  });

  it('has name CliUserError', () => {
    const err = new CliUserError({ summary: 'Error' });
    expect(err.name).toBe('CliUserError');
  });

  it('is an instance of Error', () => {
    const err = new CliUserError({ summary: 'Error' });
    expect(err).toBeInstanceOf(Error);
  });
});

describe('isCliUserError', () => {
  it('returns true for CliUserError', () => {
    expect(isCliUserError(new CliUserError({ summary: 'Error' }))).toBe(true);
  });

  it('returns false for plain Error', () => {
    expect(isCliUserError(new Error('Error'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(isCliUserError(null)).toBe(false);
  });

  it('returns false for non-error objects', () => {
    expect(isCliUserError({ summary: 'Error' })).toBe(false);
  });
});
