import type { ApiKeySlotMeta, ProfileStoreData, SecretProvider, TenantProfile } from './profile';

export interface SecretStore {
  setSlotSecret(tenantId: string, provider: SecretProvider, slotId: string, value: string): Promise<void>;
  getSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<string | undefined>;
  clearSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<void>;
}

export interface ProfileStore {
  getData(): Promise<ProfileStoreData>;
  migrateIfNeeded(): Promise<void>;
  listTenants(): Promise<TenantProfile[]>;
  getTenant(tenantId: string): Promise<TenantProfile | undefined>;
  upsertTenant(input: {
    id: string;
    name?: string;
    hubBaseUrl?: string;
    entryBaseUrl?: string;
    apiProvider?: SecretProvider;
  }): Promise<TenantProfile>;
  removeTenant(tenantId: string): Promise<void>;
  setActiveTenant(tenantId: string): Promise<void>;
  getActiveTenant(): Promise<TenantProfile | undefined>;
  listKeySlots(tenantId: string, provider?: SecretProvider): Promise<ApiKeySlotMeta[]>;
  addKeySlot(
    tenantId: string,
    provider: SecretProvider,
    input: { name: string; slotId?: string; fingerprint: string }
  ): Promise<ApiKeySlotMeta>;
  updateKeySlot(
    tenantId: string,
    provider: SecretProvider,
    slotRef: string,
    update: { name?: string; fingerprint?: string; lastValidatedAt?: string }
  ): Promise<ApiKeySlotMeta>;
  removeKeySlot(tenantId: string, provider: SecretProvider, slotRef: string): Promise<void>;
  getActiveKeySlot(tenantId: string, provider: SecretProvider): Promise<ApiKeySlotMeta | undefined>;
  setActiveKeySlot(tenantId: string, provider: SecretProvider, slotRef: string): Promise<ApiKeySlotMeta>;
}
