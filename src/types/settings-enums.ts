export const INSPECT_PROVIDER_SCOPES = ['organization', 'partner', 'auto'] as const;
export type InspectProviderScope = (typeof INSPECT_PROVIDER_SCOPES)[number];

export const SECRET_STORE_BACKEND_SELECTORS = ['auto', 'native', 'file'] as const;
export type SecretStoreBackendSelector = (typeof SECRET_STORE_BACKEND_SELECTORS)[number];
