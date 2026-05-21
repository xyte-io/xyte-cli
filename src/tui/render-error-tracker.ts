/**
 * Tracks repeated render errors within a sliding window to detect
 * and freeze on runaway render failures in TUI screens.
 */
export interface RenderErrorTracker {
  /** Call after a successful render to reset the error window. */
  recordSuccess(): void;
  /** Call when a render throws. Returns true if the screen should freeze. */
  recordError(message: string): boolean;
  /** Whether the screen is frozen due to repeated render errors. */
  readonly frozen: boolean;
}

export function createRenderErrorTracker(): RenderErrorTracker {
  let errorMessage = '';
  let errorCount = 0;
  let windowStart = 0;
  let frozen = false;

  return {
    recordSuccess() {
      errorMessage = '';
      errorCount = 0;
      windowStart = 0;
    },

    recordError(message: string): boolean {
      const now = Date.now();
      if (message === errorMessage && now - windowStart <= 2_000) {
        errorCount += 1;
      } else {
        errorMessage = message;
        errorCount = 1;
        windowStart = now;
      }
      if (errorCount >= 3) {
        frozen = true;
      }
      return frozen;
    },

    get frozen() {
      return frozen;
    }
  };
}
