import { describe, expect, it, vi } from 'vitest';

import { confirmWriteWithToken, openActionPalette, parseJsonObjectInput, promptChoice } from '../../src/tui/actions';

describe('tui actions helpers', () => {
  it('runs selected palette action', async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const context: Parameters<typeof openActionPalette>[0]['context'] = {
      prompt: vi.fn().mockResolvedValue('1'),
      setStatus: vi.fn(),
      showError: vi.fn()
    };

    await openActionPalette({
      context,
      title: 'Actions',
      actions: [{ label: 'Do thing', run }]
    });

    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not run disabled palette action', async () => {
    const run = vi.fn();
    const context: Parameters<typeof openActionPalette>[0]['context'] = {
      prompt: vi.fn().mockResolvedValue('1'),
      setStatus: vi.fn(),
      showError: vi.fn()
    };

    await openActionPalette({
      context,
      title: 'Actions',
      actions: [{ label: 'Disabled', enabled: false, disabledReason: 'disabled', run }]
    });

    expect(run).not.toHaveBeenCalled();
    expect(context.setStatus).toHaveBeenCalledWith('disabled');
  });

  it('requires exact token for write confirmation', async () => {
    const context: Parameters<typeof confirmWriteWithToken>[0]['context'] = {
      confirmWrite: vi.fn().mockResolvedValue(false),
      setStatus: vi.fn()
    };

    const ok = await confirmWriteWithToken({
      context,
      actionLabel: 'Resolve ticket',
      token: 'resolve',
      cancelStatus: 'canceled'
    });
    expect(ok).toBe(false);
    expect(context.setStatus).toHaveBeenCalledWith('canceled');
  });

  it('returns selected prompt choice', async () => {
    const context: Parameters<typeof promptChoice>[0]['context'] = {
      prompt: vi.fn().mockResolvedValue('2'),
      setStatus: vi.fn()
    };
    const choice = await promptChoice({
      context,
      title: 'Pick one',
      choices: [
        { label: 'One', value: 'one' },
        { label: 'Two', value: 'two' }
      ]
    });

    expect(choice?.value).toBe('two');
  });

  it('parses JSON object input only', () => {
    expect(parseJsonObjectInput('{"a":1}')).toEqual({
      ok: true,
      value: { a: 1 }
    });
    expect(parseJsonObjectInput('[]').ok).toBe(false);
    expect(parseJsonObjectInput('not-json').ok).toBe(false);
  });
});
