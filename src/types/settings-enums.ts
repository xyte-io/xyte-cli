export const INSPECT_PROVIDER_SCOPES = ['organization', 'partner', 'auto'] as const;
export type InspectProviderScope = (typeof INSPECT_PROVIDER_SCOPES)[number];
