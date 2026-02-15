export const GLOBAL_KEYMAP: Array<{ keys: string; description: string }> = [
  { keys: '←/→', description: 'Switch tabs' },
  { keys: 'Ctrl+←/→ (or Shift+←/→)', description: 'Move pane focus; at pane edge, switch tab' },
  { keys: '↑/↓', description: 'Move selection or scroll in active pane' },
  { keys: 'Enter', description: 'Primary action in active pane (screen-dependent)' },
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
  { keys: 'Spaces: Enter', description: 'Load selected space details and devices asynchronously' },
  { keys: 'Devices: Enter', description: 'Open selected device details' },
  { keys: 'Tickets: R or rr', description: 'Mark selected ticket as resolved (with confirmation)' },
  { keys: 'Incidents: /', description: 'Filter incidents by severity' }
];
