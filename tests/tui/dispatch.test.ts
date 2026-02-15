import { describe, expect, it, vi } from 'vitest';

import { dispatchKeypress } from '../../src/tui/dispatch';

describe('tui key dispatch', () => {
  it('prefers screen-local handler over global handler', async () => {
    const handleScreen = vi.fn().mockResolvedValue(true);
    const handleGlobal = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchKeypress({
      ch: 's',
      key: { name: 's', full: 's' } as any,
      handleScreen,
      handleGlobal
    });

    expect(result).toBe('screen');
    expect(handleScreen).toHaveBeenCalledTimes(1);
    expect(handleGlobal).not.toHaveBeenCalled();
  });

  it('falls back to global handler when screen does not handle key', async () => {
    const handleScreen = vi.fn().mockResolvedValue(false);
    const handleGlobal = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchKeypress({
      ch: 'd',
      key: { name: 'd', full: 'd' } as any,
      handleScreen,
      handleGlobal
    });

    expect(result).toBe('global');
    expect(handleGlobal).toHaveBeenCalledTimes(1);
  });

  it('blocks global and screen handlers when modal is active', async () => {
    const handleScreen = vi.fn().mockResolvedValue(false);
    const handleGlobal = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchKeypress({
      ch: 'd',
      key: { name: 'd', full: 'd' } as any,
      isModalActive: true,
      handleScreen,
      handleGlobal
    });

    expect(result).toBe('blocked');
    expect(handleScreen).not.toHaveBeenCalled();
    expect(handleGlobal).not.toHaveBeenCalled();
  });

  it('routes arrow keys to screen arrow handler before global handler', async () => {
    const handleArrow = vi.fn().mockResolvedValue('handled');
    const handleScreen = vi.fn().mockResolvedValue(false);
    const handleGlobal = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchKeypress({
      ch: undefined,
      key: { name: 'down', full: 'down' } as any,
      handleArrow,
      handleScreen,
      handleGlobal
    });

    expect(result).toBe('arrow');
    expect(handleArrow).toHaveBeenCalledTimes(1);
    expect(handleScreen).not.toHaveBeenCalled();
    expect(handleGlobal).not.toHaveBeenCalled();
  });

  it('keeps arrows blocked while modal is active', async () => {
    const handleArrow = vi.fn().mockResolvedValue('handled');
    const handleGlobal = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchKeypress({
      ch: undefined,
      key: { name: 'left', full: 'left' } as any,
      isModalActive: true,
      handleArrow,
      handleGlobal
    });

    expect(result).toBe('blocked');
    expect(handleArrow).not.toHaveBeenCalled();
    expect(handleGlobal).not.toHaveBeenCalled();
  });

  it('routes horizontal arrows to global handler by default', async () => {
    const handleArrow = vi.fn().mockResolvedValue('handled');
    const handleGlobal = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchKeypress({
      ch: undefined,
      key: { name: 'right', full: 'right' } as any,
      handleArrow,
      handleGlobal
    });

    expect(result).toBe('global');
    expect(handleArrow).not.toHaveBeenCalled();
    expect(handleGlobal).toHaveBeenCalledTimes(1);
  });

  it('bypasses global horizontal arrow routing when screen requests text-edit priority', async () => {
    const handleArrow = vi.fn().mockResolvedValue('handled');
    const handleGlobal = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchKeypress({
      ch: undefined,
      key: { name: 'left', full: 'left' } as any,
      handleArrow,
      handleGlobal,
      shouldBypassHorizontalGlobal: () => true
    });

    expect(result).toBe('blocked');
    expect(handleArrow).not.toHaveBeenCalled();
    expect(handleGlobal).not.toHaveBeenCalled();
  });

  it('falls through to global handler when pane-mode arrow reaches pane boundary', async () => {
    const handleArrow = vi.fn().mockResolvedValue('boundary');
    const handleGlobal = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchKeypress({
      ch: undefined,
      key: { name: 'right', full: 'S-right', shift: true } as any,
      handleArrow,
      handleGlobal
    });

    expect(result).toBe('global');
    expect(handleArrow).toHaveBeenCalledTimes(1);
    expect(handleGlobal).toHaveBeenCalledTimes(1);
  });

  it('routes pane-mode horizontal arrows to screen arrow handler', async () => {
    const handleArrow = vi.fn().mockResolvedValue('handled');
    const handleGlobal = vi.fn().mockResolvedValue(undefined);

    const result = await dispatchKeypress({
      ch: undefined,
      key: { name: 'left', full: 'C-left', ctrl: true } as any,
      handleArrow,
      handleGlobal
    });

    expect(result).toBe('arrow');
    expect(handleArrow).toHaveBeenCalledTimes(1);
    expect(handleGlobal).not.toHaveBeenCalled();
  });
});
