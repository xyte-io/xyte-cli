import { describe, expect, it, vi } from 'vitest';

import { logScreenDataFetch, createScreenRenderLogger } from '../../src/tui/screen-render-logger';

const fakeRenderErrors = { frozen: false } as { frozen: boolean };

describe('logScreenDataFetch', () => {
  it('calls debugLog with the correct event and data', () => {
    const debugLog = vi.fn();
    logScreenDataFetch(debugLog, 'devices', 'start', { count: 3 });
    expect(debugLog).toHaveBeenCalledWith('screen.data.fetch.start', { screen: 'devices', count: 3 });
  });

  it('appends phase to event name', () => {
    const debugLog = vi.fn();
    logScreenDataFetch(debugLog, 'tickets', 'error', { reason: 'timeout' });
    expect(debugLog).toHaveBeenCalledWith('screen.data.fetch.error', { screen: 'tickets', reason: 'timeout' });
  });

  it('is a no-op when debugLog is undefined', () => {
    expect(() => logScreenDataFetch(undefined, 'spaces', 'complete', {})).not.toThrow();
  });
});

describe('createScreenRenderLogger', () => {
  it('emits screen.render.start on onRenderStart', () => {
    const debugLog = vi.fn();
    const logger = createScreenRenderLogger('devices', () => debugLog, fakeRenderErrors);
    logger.onRenderStart();
    expect(debugLog).toHaveBeenCalledWith('screen.render.start', { screen: 'devices', frozen: false });
  });

  it('emits screen.render.complete on onRenderComplete', () => {
    const debugLog = vi.fn();
    const logger = createScreenRenderLogger('tickets', () => debugLog, fakeRenderErrors);
    logger.onRenderComplete();
    expect(debugLog).toHaveBeenCalledWith('screen.render.complete', { screen: 'tickets', frozen: false });
  });

  it('emits screen.render.error and fallback on onRenderError', () => {
    const debugLog = vi.fn();
    const logger = createScreenRenderLogger('spaces', () => debugLog, fakeRenderErrors);
    logger.onRenderError('render failed');
    expect(debugLog).toHaveBeenCalledWith('screen.render.error', { screen: 'spaces', message: 'render failed', frozen: false });
    expect(debugLog).toHaveBeenCalledWith('screen.render.fallback.applied', { screen: 'spaces' });
  });

  it('is a no-op when getDebugLog returns undefined', () => {
    const logger = createScreenRenderLogger('spaces', () => undefined, fakeRenderErrors);
    expect(() => logger.onRenderStart()).not.toThrow();
    expect(() => logger.onRenderComplete()).not.toThrow();
    expect(() => logger.onRenderError('err')).not.toThrow();
  });
});
