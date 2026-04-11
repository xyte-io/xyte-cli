import { describe, expect, it, vi } from 'vitest';

import { ScreenRuntime } from '../../src/tui/runtime';
import { CHAR_SCREEN_MAP, updateErrorStormState } from '../../src/tui/app';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}


describe('CHAR_SCREEN_MAP', () => {
  it('maps every expected key to the correct screen id', () => {
    expect(CHAR_SCREEN_MAP['u']).toBe('setup');
    expect(CHAR_SCREEN_MAP['g']).toBe('config');
    expect(CHAR_SCREEN_MAP['d']).toBe('dashboard');
    expect(CHAR_SCREEN_MAP['s']).toBe('spaces');
    expect(CHAR_SCREEN_MAP['v']).toBe('devices');
    expect(CHAR_SCREEN_MAP['i']).toBe('incidents');
    expect(CHAR_SCREEN_MAP['t']).toBe('tickets');
  });

  it('has exactly 7 entries', () => {
    expect(Object.keys(CHAR_SCREEN_MAP)).toHaveLength(7);
  });

  it('returns undefined for unmapped keys', () => {
    expect(CHAR_SCREEN_MAP['r']).toBeUndefined();
    expect(CHAR_SCREEN_MAP['x']).toBeUndefined();
  });
});

describe('tui app navigation runtime', () => {
  it('queues refresh requests while one is in flight without blocking dispatch', async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    let calls = 0;

    const runtime = new ScreenRuntime({
      async refresh() {
        calls += 1;
        if (calls === 1) {
          await first.promise;
          return;
        }
        await second.promise;
      }
    });
    runtime.setMountToken(1);

    runtime.runRefresh('mount');
    runtime.runRefresh('manual');

    const pendingStatus = runtime.getStatus();
    expect(pendingStatus.refreshInFlight).toBe(true);
    expect(pendingStatus.refreshQueued).toBe(true);

    first.resolve();
    await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(2));
    second.resolve();
    await vi.waitFor(() => {
      expect(runtime.getStatus().state).toBe('idle');
      expect(runtime.getStatus().refreshInFlight).toBe(false);
    });

    expect(calls).toBe(2);
  });

  it('discards stale completion when mount token changes', async () => {
    const done = deferred<void>();
    const runtime = new ScreenRuntime({
      refresh: async () => {
        await done.promise;
      }
    });
    runtime.setMountToken(1);
    runtime.runRefresh('mount');

    runtime.setMountToken(2);
    done.resolve();
    await vi.waitFor(() => expect(runtime.getStatus().staleDiscarded).toBeGreaterThan(0));

    expect(runtime.getStatus().staleDiscarded).toBeGreaterThan(0);
  });

  it('tracks repeated identical errors inside a bounded window', () => {
    const baseTs = 1_000;
    const first = updateErrorStormState({ message: '', count: 0, startedAt: 0 }, 'boom', baseTs);
    const second = updateErrorStormState(first, 'boom', baseTs + 400);
    const third = updateErrorStormState(second, 'boom', baseTs + 900);
    const reset = updateErrorStormState(third, 'different', baseTs + 1_100);
    const afterWindow = updateErrorStormState(reset, 'different', baseTs + 4_000);

    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(third.count).toBe(3);
    expect(reset.count).toBe(1);
    expect(afterWindow.count).toBe(1);
  });
});
