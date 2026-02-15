import type {
  ApiKeySlotMeta,
  LLMProfileUpdate,
  ProfileStoreData,
  SecretProvider,
  TenantKeyRegistry,
  TenantProfile
} from '../../src/types/profile';
import type { ProfileStore } from '../../src/secure/profile-store';
import { buildSlotId, ensureSlotName, matchesSlotRef } from '../../src/secure/key-slots';

function emptyRegistry(): TenantKeyRegistry {
  return {
    slots: [],
    activeSlotByProvider: {}
  };
}

export class MemoryProfileStore implements ProfileStore {
  private data: ProfileStoreData = {
    version: 2,
    globalDefaultLLMProvider: 'openai',
    tenants: []
  };

  async getData(): Promise<ProfileStoreData> {
    return structuredClone(this.data);
  }

  async listTenants(): Promise<TenantProfile[]> {
    return structuredClone(this.data.tenants);
  }

  async getTenant(tenantId: string): Promise<TenantProfile | undefined> {
    return this.data.tenants.find((tenant) => tenant.id === tenantId);
  }

  async upsertTenant(input: {
    id: string;
    name?: string;
    hubBaseUrl?: string;
    entryBaseUrl?: string;
    openaiCompatibleBaseUrl?: string;
  }): Promise<TenantProfile> {
    const existing = this.data.tenants.find((tenant) => tenant.id === input.id);
    const now = new Date().toISOString();

    if (existing) {
      existing.name = input.name ?? existing.name;
      existing.hubBaseUrl = input.hubBaseUrl ?? existing.hubBaseUrl;
      existing.entryBaseUrl = input.entryBaseUrl ?? existing.entryBaseUrl;
      existing.openaiCompatibleBaseUrl = input.openaiCompatibleBaseUrl ?? existing.openaiCompatibleBaseUrl;
      existing.keyRegistry = existing.keyRegistry ?? emptyRegistry();
      existing.updatedAt = now;
      return structuredClone(existing);
    }

    const tenant: TenantProfile = {
      id: input.id,
      name: input.name ?? input.id,
      hubBaseUrl: input.hubBaseUrl,
      entryBaseUrl: input.entryBaseUrl,
      openaiCompatibleBaseUrl: input.openaiCompatibleBaseUrl,
      keyRegistry: emptyRegistry(),
      createdAt: now,
      updatedAt: now
    };

    this.data.tenants.push(tenant);
    this.data.activeTenantId = this.data.activeTenantId ?? tenant.id;
    return structuredClone(tenant);
  }

  async removeTenant(tenantId: string): Promise<void> {
    this.data.tenants = this.data.tenants.filter((tenant) => tenant.id !== tenantId);
    if (this.data.activeTenantId === tenantId) {
      this.data.activeTenantId = this.data.tenants[0]?.id;
    }
  }

  async setActiveTenant(tenantId: string): Promise<void> {
    if (!this.data.tenants.some((tenant) => tenant.id === tenantId)) {
      throw new Error(`Unknown tenant: ${tenantId}`);
    }
    this.data.activeTenantId = tenantId;
  }

  async getActiveTenant(): Promise<TenantProfile | undefined> {
    if (!this.data.activeTenantId) {
      return undefined;
    }
    return this.getTenant(this.data.activeTenantId);
  }

  async setGlobalLLM(update: LLMProfileUpdate): Promise<ProfileStoreData> {
    if (update.provider) {
      this.data.globalDefaultLLMProvider = update.provider;
    }
    if (update.model !== undefined) {
      this.data.globalDefaultLLMModel = update.model;
    }
    return this.getData();
  }

  async setTenantLLM(tenantId: string, update: LLMProfileUpdate): Promise<TenantProfile> {
    const tenant = this.data.tenants.find((item) => item.id === tenantId);
    if (!tenant) {
      throw new Error(`Unknown tenant: ${tenantId}`);
    }

    if (update.provider) {
      tenant.defaultLLMProvider = update.provider;
    }
    if (update.model !== undefined) {
      tenant.defaultLLMModel = update.model;
    }
    tenant.updatedAt = new Date().toISOString();
    return structuredClone(tenant);
  }

  async listKeySlots(tenantId: string, provider?: SecretProvider): Promise<ApiKeySlotMeta[]> {
    const tenant = this.getRequiredTenant(tenantId);
    const slots = tenant.keyRegistry?.slots ?? [];
    return structuredClone(provider ? slots.filter((slot) => slot.provider === provider) : slots);
  }

  async addKeySlot(tenantId: string, input: { provider: SecretProvider; name: string; slotId?: string; fingerprint: string }): Promise<ApiKeySlotMeta> {
    const tenant = this.getRequiredTenant(tenantId);
    tenant.keyRegistry = tenant.keyRegistry ?? emptyRegistry();
    const registry = tenant.keyRegistry;
    const now = new Date().toISOString();
    const slotName = ensureSlotName(input.name);
    const providerSlots = registry.slots.filter((slot) => slot.provider === input.provider);
    if (providerSlots.some((slot) => slot.name.toLowerCase() === slotName.toLowerCase())) {
      throw new Error(`A key slot named "${slotName}" already exists for provider ${input.provider}.`);
    }

    const existingIds = new Set(providerSlots.map((slot) => slot.slotId));
    const slotId = input.slotId?.trim() || buildSlotId(slotName, existingIds);
    if (existingIds.has(slotId)) {
      throw new Error(`A key slot with id "${slotId}" already exists for provider ${input.provider}.`);
    }

    const slot: ApiKeySlotMeta = {
      slotId,
      provider: input.provider,
      name: slotName,
      fingerprint: input.fingerprint,
      createdAt: now,
      updatedAt: now
    };
    registry.slots.push(slot);
    registry.activeSlotByProvider[input.provider] = registry.activeSlotByProvider[input.provider] ?? slotId;
    tenant.updatedAt = now;
    return structuredClone(slot);
  }

  async updateKeySlot(
    tenantId: string,
    provider: SecretProvider,
    slotRef: string,
    update: { name?: string; fingerprint?: string; lastValidatedAt?: string }
  ): Promise<ApiKeySlotMeta> {
    const tenant = this.getRequiredTenant(tenantId);
    const registry = tenant.keyRegistry ?? emptyRegistry();
    const index = registry.slots.findIndex((slot) => slot.provider === provider && matchesSlotRef(slot, slotRef));
    if (index === -1) {
      throw new Error(`Unknown slot "${slotRef}" for provider ${provider}.`);
    }
    const slot = registry.slots[index];
    const nextName = update.name !== undefined ? ensureSlotName(update.name) : slot.name;
    if (nextName.toLowerCase() !== slot.name.toLowerCase()) {
      const duplicate = registry.slots.some(
        (item, idx) => idx !== index && item.provider === provider && item.name.toLowerCase() === nextName.toLowerCase()
      );
      if (duplicate) {
        throw new Error(`A key slot named "${nextName}" already exists for provider ${provider}.`);
      }
    }

    const next: ApiKeySlotMeta = {
      ...slot,
      name: nextName,
      fingerprint: update.fingerprint ?? slot.fingerprint,
      lastValidatedAt: update.lastValidatedAt ?? slot.lastValidatedAt,
      updatedAt: new Date().toISOString()
    };
    registry.slots[index] = next;
    tenant.keyRegistry = registry;
    tenant.updatedAt = next.updatedAt;
    return structuredClone(next);
  }

  async removeKeySlot(tenantId: string, provider: SecretProvider, slotRef: string): Promise<void> {
    const tenant = this.getRequiredTenant(tenantId);
    const registry = tenant.keyRegistry ?? emptyRegistry();
    const slot = registry.slots.find((item) => item.provider === provider && matchesSlotRef(item, slotRef));
    if (!slot) {
      throw new Error(`Unknown slot "${slotRef}" for provider ${provider}.`);
    }

    registry.slots = registry.slots.filter((item) => !(item.provider === provider && item.slotId === slot.slotId));
    if (registry.activeSlotByProvider[provider] === slot.slotId) {
      const fallback = registry.slots.find((item) => item.provider === provider)?.slotId;
      if (fallback) {
        registry.activeSlotByProvider[provider] = fallback;
      } else {
        delete registry.activeSlotByProvider[provider];
      }
    }
    tenant.keyRegistry = registry;
    tenant.updatedAt = new Date().toISOString();
  }

  async getActiveKeySlot(tenantId: string, provider: SecretProvider): Promise<ApiKeySlotMeta | undefined> {
    const tenant = this.getRequiredTenant(tenantId);
    const registry = tenant.keyRegistry ?? emptyRegistry();
    const active = registry.activeSlotByProvider[provider];
    if (active) {
      const slot = registry.slots.find((item) => item.provider === provider && item.slotId === active);
      if (slot) {
        return structuredClone(slot);
      }
    }
    const fallback = registry.slots.find((item) => item.provider === provider);
    return fallback ? structuredClone(fallback) : undefined;
  }

  async setActiveKeySlot(tenantId: string, provider: SecretProvider, slotRef: string): Promise<ApiKeySlotMeta> {
    const tenant = this.getRequiredTenant(tenantId);
    const registry = tenant.keyRegistry ?? emptyRegistry();
    const slot = registry.slots.find((item) => item.provider === provider && matchesSlotRef(item, slotRef));
    if (!slot) {
      throw new Error(`Unknown slot "${slotRef}" for provider ${provider}.`);
    }

    registry.activeSlotByProvider[provider] = slot.slotId;
    tenant.keyRegistry = registry;
    tenant.updatedAt = new Date().toISOString();
    return structuredClone(slot);
  }

  private getRequiredTenant(tenantId: string): TenantProfile {
    const tenant = this.data.tenants.find((item) => item.id === tenantId);
    if (!tenant) {
      throw new Error(`Unknown tenant: ${tenantId}`);
    }
    tenant.keyRegistry = tenant.keyRegistry ?? emptyRegistry();
    return tenant;
  }
}
