export const GLOBAL_KEYMAP: Array<{ keys: string; description: string }> = [
  { keys: '←/→', description: 'Switch tabs' },
  { keys: '1..7', description: 'Jump directly to tab by number' },
  { keys: 'm', description: 'Open quick screen switcher' },
  { keys: 'Ctrl+←/→ (or Shift+←/→)', description: 'Move pane focus; at pane edge, switch tab' },
  { keys: '↑/↓', description: 'Move selection or scroll in active pane' },
  { keys: 'Enter', description: 'Primary action in active pane (screen-dependent)' },
  { keys: 'o', description: 'Open deep entity details for selected item' },
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
