export const TUI_SCREEN_IDS = ['setup', 'config', 'dashboard', 'spaces', 'devices', 'incidents', 'tickets'] as const;
export type TuiScreenId = (typeof TUI_SCREEN_IDS)[number];
