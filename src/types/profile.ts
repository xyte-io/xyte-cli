export type SecretProvider = 'xyte-org' | 'xyte-partner' | 'xyte-device';

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
