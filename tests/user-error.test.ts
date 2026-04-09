import { describe, expect, it } from 'vitest';

import { CliUserError, isCliUserError } from '../src/contracts/user-error';

describe('CliUserError', () => {
  it('sets summary as message', () => {
    const err = new CliUserError({ summary: 'Something failed' });
    expect(err.message).toBe('Something failed');
    expect(err.summary).toBe('Something failed');
  });

  it('sets name to CliUserError', () => {
    const err = new CliUserError({ summary: 'test' });
    expect(err.name).toBe('CliUserError');
  });

  it('stores cause detail', () => {
    const err = new CliUserError({ summary: 'fail', detail: 'bad input' });
    expect(err.detail).toBe('bad input');
  });

  it('stores suggested commands', () => {
    const err = new CliUserError({ summary: 'fail', suggestedCommands: ['try this'] });
    expect(err.suggestedCommands).toEqual(['try this']);
  });

  it('defaults suggestedCommands to empty array', () => {
    const err = new CliUserError({ summary: 'fail' });
    expect(err.suggestedCommands).toEqual([]);
  });

  it('defaults xyteCode', () => {
    const err = new CliUserError({ summary: 'fail' });
    expect(err.xyteCode).toBe('XYTE_CLI_USER_ERROR');
  });

  it('accepts custom xyteCode', () => {
    const err = new CliUserError({ summary: 'fail', xyteCode: 'CUSTOM' });
    expect(err.xyteCode).toBe('CUSTOM');
  });

  it('is an instance of Error', () => {
    const err = new CliUserError({ summary: 'fail' });
    expect(err).toBeInstanceOf(Error);
  });
});

describe('isCliUserError', () => {
  it('returns true for CliUserError instances', () => {
    expect(isCliUserError(new CliUserError({ summary: 'fail' }))).toBe(true);
  });

  it('returns false for regular errors', () => {
    expect(isCliUserError(new Error('fail'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isCliUserError('fail')).toBe(false);
    expect(isCliUserError(null)).toBe(false);
    expect(isCliUserError(undefined)).toBe(false);
  });
});
