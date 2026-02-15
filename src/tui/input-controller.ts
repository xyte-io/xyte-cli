import type blessed from 'blessed';

export interface InputEvent {
  ch: string | undefined;
  key: blessed.Widgets.Events.IKeyEventArg;
  timestamp: number;
}

export interface InputDispatchResult {
  accepted: boolean;
  bypassed: boolean;
  queueDepth: number;
  droppedEvents: number;
}

export interface InputControllerState {
  queueDepth: number;
  droppedEvents: number;
  inFlight: boolean;
}

export interface InputControllerOptions {
  handle: (event: InputEvent) => Promise<void>;
  isCritical?: (event: InputEvent) => boolean;
  maxQueueSize?: number;
  onError?: (error: unknown) => void;
}

const DEFAULT_MAX_QUEUE_SIZE = 48;

function defaultIsCritical(event: InputEvent): boolean {
  return event.ch === 'q' || event.key.name === 'q' || event.key.full === 'C-c';
}

export function createInputController(options: InputControllerOptions) {
  const maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
  const isCritical = options.isCritical ?? defaultIsCritical;
  const queue: InputEvent[] = [];
  let inFlight = false;
  let droppedEvents = 0;

  const getState = (): InputControllerState => ({
    queueDepth: queue.length,
    droppedEvents,
    inFlight
  });

  const processQueue = async (): Promise<void> => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) {
          continue;
        }
        try {
          await options.handle(next);
        } catch (error) {
          options.onError?.(error);
        }
      }
    } finally {
      inFlight = false;
    }
  };

  const dispatch = (event: InputEvent): InputDispatchResult => {
    if (isCritical(event)) {
      void options.handle(event).catch((error) => {
        options.onError?.(error);
      });
      return {
        accepted: true,
        bypassed: true,
        queueDepth: queue.length,
        droppedEvents
      };
    }

    if (queue.length >= maxQueueSize) {
      queue.shift();
      droppedEvents += 1;
    }

    queue.push(event);
    void processQueue();
    return {
      accepted: true,
      bypassed: false,
      queueDepth: queue.length,
      droppedEvents
    };
  };

  const clear = () => {
    queue.length = 0;
  };

  return {
    dispatch,
    getState,
    clear
  };
}
