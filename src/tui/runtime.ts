import { errorMessage } from '../utils/error-format';

export function createStaleSafeSelectionLoader<TInput, TResult>(args: {
  load: (input: TInput) => Promise<TResult>;
  apply: (result: TResult) => void;
}): (input: TInput) => Promise<boolean> {
  let token = 0;

  return async (input: TInput): Promise<boolean> => {
    const current = ++token;
    const result = await args.load(input);
    if (current !== token) {
      return false;
    }
    args.apply(result);
    return true;
  };
}

export type RefreshReason = 'mount' | 'manual' | 'background' | 'readiness';
export type RefreshState = 'idle' | 'loading' | 'retrying' | 'error';

export interface ScreenRuntimeStatus {
  state: RefreshState;
  refreshInFlight: boolean;
  refreshQueued: boolean;
  staleDiscarded: number;
  lastError?: string;
  reason?: RefreshReason;
}

interface ScreenRuntimeOptions {
  refresh: () => Promise<void>;
  onStatus?: (status: ScreenRuntimeStatus) => void;
  onError?: (error: unknown) => void;
}

export class ScreenRuntime {
  private mountToken = 0;
  private refreshToken = 0;
  private refreshInFlight = false;
  private refreshQueued = false;
  private staleDiscarded = 0;
  private lastError: string | undefined;
  private state: RefreshState = 'idle';
  private reason: RefreshReason | undefined;
  private readonly options: ScreenRuntimeOptions;

  constructor(options: ScreenRuntimeOptions) {
    this.options = options;
  }

  getStatus(): ScreenRuntimeStatus {
    return {
      state: this.state,
      refreshInFlight: this.refreshInFlight,
      refreshQueued: this.refreshQueued,
      staleDiscarded: this.staleDiscarded,
      lastError: this.lastError,
      reason: this.reason
    };
  }

  setMountToken(token: number): void {
    this.mountToken = token;
  }

  cancelPendingForUnmount(): void {
    this.mountToken += 1;
    this.refreshToken += 1;
    this.refreshInFlight = false;
    this.refreshQueued = false;
    this.state = 'idle';
    this.reason = undefined;
    this.emitStatus();
  }

  runRefresh(reason: RefreshReason): void {
    this.reason = reason;
    if (this.refreshInFlight) {
      this.refreshQueued = true;
      this.state = 'retrying';
      this.emitStatus();
      return;
    }

    void this.execute(this.mountToken);
  }

  private async execute(expectedMountToken: number): Promise<void> {
    this.refreshInFlight = true;
    this.refreshQueued = false;
    this.state = 'loading';
    this.emitStatus();

    const token = ++this.refreshToken;
    try {
      await this.options.refresh();
      if (expectedMountToken !== this.mountToken || token !== this.refreshToken) {
        this.staleDiscarded += 1;
        return;
      }
      this.lastError = undefined;
      this.state = 'idle';
      this.emitStatus();
    } catch (error) {
      if (expectedMountToken !== this.mountToken || token !== this.refreshToken) {
        this.staleDiscarded += 1;
        return;
      }
      this.lastError = errorMessage(error);
      this.state = 'error';
      this.options.onError?.(error);
      this.emitStatus();
    } finally {
      if (expectedMountToken === this.mountToken && token === this.refreshToken) {
        this.refreshInFlight = false;
        if (this.refreshQueued) {
          this.refreshQueued = false;
          this.state = 'retrying';
          this.emitStatus();
          void this.execute(expectedMountToken);
          return;
        }
      }
      this.emitStatus();
    }
  }

  private emitStatus(): void {
    this.options.onStatus?.(this.getStatus());
  }
}
