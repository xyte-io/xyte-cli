import type { TuiScreenId } from './types';

export const GLOBAL_KEYMAP: Array<{ keys: string; description: string }> = [
  { keys: 'Tab / Shift+Tab', description: 'Switch screens' },
  { keys: '1-7', description: 'Jump directly to a screen' },
  { keys: '←/→', description: 'Move pane focus in the current screen' },
  { keys: '↑/↓', description: 'Move selection or scroll in active pane' },
  { keys: 'Enter', description: 'Open or drill into the focused item/pane' },
  { keys: 'Esc / Backspace', description: 'Go back one level in the current screen' },
  { keys: 'a', description: 'Open action palette (ops screens)' },
  { keys: 'f', description: 'Open structured filter editor (ops screens)' },
  { keys: '[ / ]', description: 'Previous/next page (where supported)' },
  { keys: 'p', description: 'Set per-page size (where supported)' },
  { keys: 'u', description: 'Setup' },
  { keys: 'g', description: 'Config' },
  { keys: 'd', description: 'Dashboard' },
  { keys: 's', description: 'Spaces' },
  { keys: 'v', description: 'Devices' },
  { keys: 'i', description: 'Incidents' },
  { keys: 't', description: 'Tickets' },
  { keys: 'r', description: 'Refresh current screen' },
  { keys: '/', description: 'Search or filter in current screen' },
  { keys: '?', description: 'Show key help' },
  { keys: 'q', description: 'Quit TUI' }
];

export const SCREEN_ACTION_KEYMAP: Array<{ keys: string; description: string }> = [
  { keys: 'Setup: a/u/k/p/c/r', description: 'Tenant setup + guided key wizard + connectivity checks' },
  { keys: 'Config: a/n/u/e/t/x/c/r', description: 'Provider-first key slot add/rename/use/rotate/test/remove + doctor' },
  { keys: 'Spaces: a/f/Enter', description: 'Claim device, create/rename space, endpoint filters, and drilldown' },
  { keys: 'Devices: a/f/Enter', description: 'Send command via templates, endpoint space filter, and details' },
  { keys: 'Tickets: a/f/R/rr/[ ]/p', description: 'Resolve/send message, local filters and paging controls' },
  { keys: 'Incidents: a/f/[ ]/p/', description: 'Close incident, endpoint filters, paging, and severity quick filter' }
];

export const SCREEN_INLINE_HINTS: Record<TuiScreenId, string> = {
  setup: 'Tab screens • arrows move panes • visible panel focus • a tenant actions • k guided key wizard • c connectivity',
  config: 'Tab screens • arrows move panes • visible panel focus • a add slot • e update key • t test slot • x remove',
  dashboard: 'Tab screens • arrows move panes • Enter open related screen • Esc back • r refresh',
  spaces: 'Tab screens • arrows move panes • Enter open space/device branch • Esc back • / search • f filters • a actions',
  devices: 'Tab screens • arrows move panes • Enter open device detail • Esc back • / search • f filters • a actions',
  incidents: 'Tab screens • arrows move panes • Enter open incident detail • Esc back • / severity • f filters • [ ] page',
  tickets: 'Tab screens • arrows move panes • Enter open ticket detail • Esc back • / search • f filters • [ ] page'
};
