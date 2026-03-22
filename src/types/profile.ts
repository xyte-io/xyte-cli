export const SUPPORTED_SECRET_PROVIDERS = ['xyte-org', 'xyte-partner'] as const;

export type SecretProvider = (typeof SUPPORTED_SECRET_PROVIDERS)[number];

export const PROVIDER_ORG = 'xyte-org' as const;
export const PROVIDER_PARTNER = 'xyte-partner' as const;

export function isSecretProvider(value: string): value is SecretProvider {
  return (SUPPORTED_SECRET_PROVIDERS as readonly string[]).includes(value);
}

export interface ApiKeySlotMeta {
  slotId: string;
  provider: SecretProvider;
  name: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
}

export interface TenantKeyRegistry {
  slots: ApiKeySlotMeta[];
  activeSlotByProvider: Partial<Record<SecretProvider, string>>;
}

export interface TenantProfile {
  id: string;
  name: string;
  hubBaseUrl?: string;
  entryBaseUrl?: string;
  keyRegistry: TenantKeyRegistry;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileStoreData {
  version: 2;
  activeTenantId?: string;
  tenants: TenantProfile[];
}
