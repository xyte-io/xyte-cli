import { describe, expect, it, vi } from 'vitest';

import { createInputController } from '../../src/tui/input-controller';

function key(full: string) {
  return { name: full, full } as any;
}

describe('tui input controller', () => {
  it('processes non-critical events serially', async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const controller = createInputController({
      async handle(event) {
        order.push(`start:${event.ch}`);
        if (event.ch === 'a') {
          await firstDone;
        }
        order.push(`end:${event.ch}`);
      },
      maxQueueSize: 10
    });

    controller.dispatch({ ch: 'a', key: key('a'), timestamp: Date.now() });
    controller.dispatch({ ch: 'b', key: key('b'), timestamp: Date.now() });
    controller.dispatch({ ch: 'c', key: key('c'), timestamp: Date.now() });
    expect(controller.getState().queueDepth).toBeGreaterThanOrEqual(2);

    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
    expect(controller.getState().queueDepth).toBe(0);
  });

  it('drops old events when queue is full', async () => {
    const handled: Array<string | undefined> = [];
    let releaseFirst: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const controller = createInputController({
      async handle(event) {
        if (event.ch === 'a') {
          await firstDone;
        }
        handled.push(event.ch);
      },
      maxQueueSize: 2
    });

    controller.dispatch({ ch: 'a', key: key('a'), timestamp: Date.now() });
    controller.dispatch({ ch: 'b', key: key('b'), timestamp: Date.now() });
    controller.dispatch({ ch: 'c', key: key('c'), timestamp: Date.now() });
    controller.dispatch({ ch: 'd', key: key('d'), timestamp: Date.now() });
    controller.dispatch({ ch: 'e', key: key('e'), timestamp: Date.now() });

    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(controller.getState().droppedEvents).toBeGreaterThanOrEqual(1);
    expect(handled).toContain('e');
  });

  it('bypasses queue for critical events', async () => {
    const handle = vi.fn().mockResolvedValue(undefined);
    const controller = createInputController({
      handle
    });

    const result = controller.dispatch({
      ch: 'q',
      key: key('q'),
      timestamp: Date.now()
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.bypassed).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it('treats q keyname as critical even when ch is missing', async () => {
    const handle = vi.fn().mockResolvedValue(undefined);
    const controller = createInputController({
      handle
    });

    const result = controller.dispatch({
      ch: undefined,
      key: { name: 'q', full: 'q' } as any,
      timestamp: Date.now()
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(result.bypassed).toBe(true);
    expect(handle).toHaveBeenCalledTimes(1);
  });
});
