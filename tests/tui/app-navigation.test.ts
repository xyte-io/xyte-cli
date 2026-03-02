import { describe, expect, it } from 'vitest';

import { ScreenRuntime } from '../../src/tui/runtime';
import { updateErrorStormState, parseScreenShortcut } from '../../src/tui/app';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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
    await waitFor(() => calls >= 2);
    second.resolve();
    await waitFor(() => runtime.getStatus().state === 'idle' && runtime.getStatus().refreshInFlight === false);

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
    await waitFor(() => runtime.getStatus().staleDiscarded > 0);

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

describe('parseScreenShortcut', () => {
  it('parses numeric shortcuts', () => {
    expect(parseScreenShortcut('1')).toBe('setup');
    expect(parseScreenShortcut('2')).toBe('config');
    expect(parseScreenShortcut('3')).toBe('dashboard');
    expect(parseScreenShortcut('4')).toBe('spaces');
    expect(parseScreenShortcut('5')).toBe('devices');
    expect(parseScreenShortcut('6')).toBe('incidents');
    expect(parseScreenShortcut('7')).toBe('tickets');
  });

  it('parses exact screen name matches', () => {
    expect(parseScreenShortcut('setup')).toBe('setup');
    expect(parseScreenShortcut('config')).toBe('config');
    expect(parseScreenShortcut('dashboard')).toBe('dashboard');
    expect(parseScreenShortcut('spaces')).toBe('spaces');
    expect(parseScreenShortcut('devices')).toBe('devices');
    expect(parseScreenShortcut('incidents')).toBe('incidents');
    expect(parseScreenShortcut('tickets')).toBe('tickets');
  });

  it('parses prefix matches', () => {
    expect(parseScreenShortcut('set')).toBe('setup');
    expect(parseScreenShortcut('con')).toBe('config');
    expect(parseScreenShortcut('dash')).toBe('dashboard');
    expect(parseScreenShortcut('spa')).toBe('spaces');
    expect(parseScreenShortcut('dev')).toBe('devices');
    expect(parseScreenShortcut('inc')).toBe('incidents');
    expect(parseScreenShortcut('tick')).toBe('tickets');
  });

  it('handles case insensitivity', () => {
    expect(parseScreenShortcut('SETUP')).toBe('setup');
    expect(parseScreenShortcut('DashBoard')).toBe('dashboard');
    expect(parseScreenShortcut('DEV')).toBe('devices');
  });

  it('handles whitespace', () => {
    expect(parseScreenShortcut('  setup  ')).toBe('setup');
    expect(parseScreenShortcut('  1  ')).toBe('setup');
  });

  it('returns undefined for empty or invalid input', () => {
    expect(parseScreenShortcut('')).toBeUndefined();
    expect(parseScreenShortcut('   ')).toBeUndefined();
    expect(parseScreenShortcut('invalid')).toBeUndefined();
    expect(parseScreenShortcut('xyz')).toBeUndefined();
  });

  it('returns first prefix match when ambiguous', () => {
    // If there were screens with overlapping prefixes, this would test that behavior
    // Currently all screen names have unique prefixes
    expect(parseScreenShortcut('s')).toBe('setup');
  });
});
