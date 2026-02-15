import type { TuiScreenId } from './types';

export const TAB_ORDER: TuiScreenId[] = ['setup', 'config', 'dashboard', 'spaces', 'devices', 'incidents', 'tickets', 'copilot'];

export function nextTab(current: TuiScreenId, direction: 'left' | 'right'): TuiScreenId {
  const currentIndex = TAB_ORDER.indexOf(current);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const delta = direction === 'left' ? -1 : 1;
  const nextIndex = (safeIndex + delta + TAB_ORDER.length) % TAB_ORDER.length;
  return TAB_ORDER[nextIndex];
}
