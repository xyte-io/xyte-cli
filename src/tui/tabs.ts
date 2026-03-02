import type { TuiScreenId } from './types';

export const TAB_ORDER: TuiScreenId[] = ['setup', 'config', 'dashboard', 'spaces', 'devices', 'incidents', 'tickets'];

export interface ScreenShortcut {
  key: string;
  screen: TuiScreenId;
  label: string;
}

/**
 * Numeric shortcuts for the first seven screens (1-7).
 * This is the single source of truth for both keyboard shortcuts and tab labels.
 */
export const SCREEN_SHORTCUTS: ScreenShortcut[] = TAB_ORDER.slice(0, 7).map((screen, index) => {
  const key = String(index + 1);
  const label = screen.charAt(0).toUpperCase() + screen.slice(1);
  return { key, screen, label };
});

export function nextTab(current: TuiScreenId, direction: 'left' | 'right'): TuiScreenId {
  const currentIndex = TAB_ORDER.indexOf(current);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const delta = direction === 'left' ? -1 : 1;
  const nextIndex = (safeIndex + delta + TAB_ORDER.length) % TAB_ORDER.length;
  return TAB_ORDER[nextIndex];
}
