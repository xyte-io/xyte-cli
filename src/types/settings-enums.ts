export const INSPECT_PROVIDER_SCOPES = ['organization', 'partner', 'auto'] as const;
export type InspectProviderScope = (typeof INSPECT_PROVIDER_SCOPES)[number];

export function parseInspectProviderScope(value: string | undefined): InspectProviderScope {
  const normalized = (value ?? 'auto').trim().toLowerCase();
  if (!(INSPECT_PROVIDER_SCOPES as readonly string[]).includes(normalized)) {
    throw new Error(`Invalid inspect provider scope: "${value}". Expected organization|partner|auto.`);
  }
  return normalized as InspectProviderScope;
}

export const TUI_SCREEN_IDS = ['setup', 'config', 'dashboard', 'spaces', 'devices', 'incidents', 'tickets'] as const;
export type TuiScreenId = (typeof TUI_SCREEN_IDS)[number];
