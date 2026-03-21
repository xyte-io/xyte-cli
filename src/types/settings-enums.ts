export const INSPECT_PROVIDER_SCOPES = ['organization', 'partner', 'auto'] as const;
export type InspectProviderScope = (typeof INSPECT_PROVIDER_SCOPES)[number];

export const TUI_SCREEN_IDS = ['setup', 'config', 'dashboard', 'spaces', 'devices', 'incidents', 'tickets'] as const;
export type TuiScreenId = (typeof TUI_SCREEN_IDS)[number];
