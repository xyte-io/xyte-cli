import type blessed from 'blessed';
import type { TuiArrowHandleResult, TuiArrowKey } from './types';

const ARROW_KEYS: TuiArrowKey[] = ['up', 'down', 'left', 'right'];

export interface KeyDispatchArgs {
  ch: string | undefined;
  key: blessed.Widgets.Events.IKeyEventArg;
  handleScreen?: (ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) => Promise<boolean>;
  handleArrow?: (key: TuiArrowKey) => Promise<TuiArrowHandleResult>;
  shouldBypassHorizontalGlobal?: () => boolean;
  isModalActive?: boolean;
  handleModal?: (ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) => Promise<boolean | void>;
  handleGlobal: (ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) => Promise<void>;
}

export async function dispatchKeypress(args: KeyDispatchArgs): Promise<'screen' | 'arrow' | 'global' | 'modal' | 'blocked'> {
  if (args.isModalActive) {
    const handledByModal = await args.handleModal?.(args.ch, args.key);
    if (handledByModal) {
      return 'modal';
    }
    return 'blocked';
  }

  const keyName = args.key.name as TuiArrowKey | undefined;
  if (keyName && ARROW_KEYS.includes(keyName)) {
    const horizontal = keyName === 'left' || keyName === 'right';
    const paneModeRequested = Boolean(args.key.ctrl || args.key.meta || args.key.shift);
    if (horizontal && !paneModeRequested && args.shouldBypassHorizontalGlobal?.()) {
      return 'blocked';
    }
    if (horizontal && !paneModeRequested) {
      await args.handleGlobal(args.ch, args.key);
      return 'global';
    }
    if (args.handleArrow) {
      const handled = await args.handleArrow(keyName);
      if (handled === 'handled') {
        return 'arrow';
      }
      if (handled === 'boundary') {
        await args.handleGlobal(args.ch, args.key);
        return 'global';
      }
    }
  }

  if (args.handleScreen) {
    const handled = await args.handleScreen(args.ch, args.key);
    if (handled) {
      return 'screen';
    }
  }

  await args.handleGlobal(args.ch, args.key);
  return 'global';
}
