import { describe, expect, it } from 'vitest';

import { createRenderErrorTracker } from '../src/tui/render-error-tracker';

describe('createRenderErrorTracker', () => {
  it('starts unfrozen', () => {
    const tracker = createRenderErrorTracker();
    expect(tracker.frozen).toBe(false);
  });

  it('does not freeze on a single error', () => {
    const tracker = createRenderErrorTracker();
    tracker.recordError('boom');
    expect(tracker.frozen).toBe(false);
  });

  it('freezes after 3 repeated errors within the window', () => {
    const tracker = createRenderErrorTracker();
    tracker.recordError('boom');
    tracker.recordError('boom');
    const shouldFreeze = tracker.recordError('boom');
    expect(shouldFreeze).toBe(true);
    expect(tracker.frozen).toBe(true);
  });

  it('resets error count on success', () => {
    const tracker = createRenderErrorTracker();
    tracker.recordError('boom');
    tracker.recordError('boom');
    tracker.recordSuccess();
    tracker.recordError('boom');
    expect(tracker.frozen).toBe(false);
  });

  it('resets count when error message changes', () => {
    const tracker = createRenderErrorTracker();
    tracker.recordError('boom');
    tracker.recordError('boom');
    tracker.recordError('different');
    expect(tracker.frozen).toBe(false);
  });
});
