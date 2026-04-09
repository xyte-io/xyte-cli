import type { RenderErrorTracker } from './render-error-tracker';

type DebugLogFn = (event: string, data?: Record<string, unknown>) => void;

interface ScreenRenderLogger {
  onRenderStart(): void;
  onRenderComplete(): void;
  onRenderError(message: string): void;
}

export function createScreenRenderLogger(
  screen: string,
  getDebugLog: () => DebugLogFn | undefined,
  renderErrors: RenderErrorTracker
): ScreenRenderLogger {
  return {
    onRenderStart() {
      getDebugLog()?.('screen.render.start', { screen, frozen: renderErrors.frozen });
    },
    onRenderComplete() {
      getDebugLog()?.('screen.render.complete', { screen, frozen: renderErrors.frozen });
    },
    onRenderError(message: string) {
      getDebugLog()?.('screen.render.error', { screen, message, frozen: renderErrors.frozen });
      getDebugLog()?.('screen.render.fallback.applied', { screen });
    }
  };
}
