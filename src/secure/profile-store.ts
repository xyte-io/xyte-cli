import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  ApiKeySlotMeta,
  LLMProfileUpdate,
  ProfileStoreData,
  SecretProvider,
  TenantKeyRegistry,
  TenantProfile
} from '../types/profile';
import { getXyteConfigDir } from '../utils/config-dir';
import { buildSlotId, ensureSlotName, matchesSlotRef } from './key-slots';

const DEFAULT_DATA: ProfileStoreData = {
  version: 2,
  globalDefaultLLMProvider: 'openai',
  tenants: []
};

export interface ProfileStore {
  getData(): Promise<ProfileStoreData>;
  listTenants(): Promise<TenantProfile[]>;
  getTenant(tenantId: string): Promise<TenantProfile | undefined>;
  upsertTenant(input: {
    id: string;
    name?: string;
    hubBaseUrl?: string;
    entryBaseUrl?: string;
    openaiCompatibleBaseUrl?: string;
  }): Promise<TenantProfile>;
  removeTenant(tenantId: string): Promise<void>;
  setActiveTenant(tenantId: string): Promise<void>;
  getActiveTenant(): Promise<TenantProfile | undefined>;
  setGlobalLLM(update: LLMProfileUpdate): Promise<ProfileStoreData>;
  setTenantLLM(tenantId: string, update: LLMProfileUpdate): Promise<TenantProfile>;
  listKeySlots(tenantId: string, provider?: SecretProvider): Promise<ApiKeySlotMeta[]>;
  addKeySlot(tenantId: string, input: { provider: SecretProvider; name: string; slotId?: string; fingerprint: string }): Promise<ApiKeySlotMeta>;
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

function createEmptyRegistry(): TenantKeyRegistry {
  return {
    slots: [],
    activeSlotByProvider: {}
  };
}

function cloneRegistry(input: TenantKeyRegistry | undefined): TenantKeyRegistry {
  if (!input) {
    return createEmptyRegistry();
  }
  return {
    slots: Array.isArray(input.slots) ? input.slots.map((slot) => ({ ...slot })) : [],
    activeSlotByProvider: { ...(input.activeSlotByProvider ?? {}) }
  };
}

function normalizeTenant(raw: TenantProfile): TenantProfile {
  const now = new Date().toISOString();
  const registry = cloneRegistry(raw.keyRegistry);
  const normalizedSlots: ApiKeySlotMeta[] = registry.slots
    .filter((slot) => slot && typeof slot.provider === 'string' && typeof slot.slotId === 'string')
    .map((slot) => ({
      slotId: slot.slotId,
      provider: slot.provider,
      name: slot.name || slot.slotId,
      fingerprint: slot.fingerprint || 'sha256:unknown',
      createdAt: slot.createdAt || now,
      updatedAt: slot.updatedAt || now,
      lastValidatedAt: slot.lastValidatedAt
    }));

  const activeSlotByProvider: Partial<Record<SecretProvider, string>> = { ...(registry.activeSlotByProvider ?? {}) };
  const providers = new Set(normalizedSlots.map((slot) => slot.provider));
  for (const provider of providers) {
    const active = activeSlotByProvider[provider];
    const exists = normalizedSlots.some((slot) => slot.provider === provider && slot.slotId === active);
    if (!exists) {
      activeSlotByProvider[provider] = normalizedSlots.find((slot) => slot.provider === provider)?.slotId;
    }
  }

  return {
    id: raw.id,
    name: raw.name ?? raw.id,
    hubBaseUrl: raw.hubBaseUrl,
    entryBaseUrl: raw.entryBaseUrl,
    openaiCompatibleBaseUrl: raw.openaiCompatibleBaseUrl,
    defaultLLMProvider: raw.defaultLLMProvider,
    defaultLLMModel: raw.defaultLLMModel,
    keyRegistry: {
      slots: normalizedSlots,
      activeSlotByProvider
    },
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now
  };
}

export class FileProfileStore implements ProfileStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(getXyteConfigDir(), 'profile.json');
  }

  async getData(): Promise<ProfileStoreData> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content) as ProfileStoreData;
      return this.normalize(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return structuredClone(DEFAULT_DATA);
      }
      throw error;
    }
  }

  async listTenants(): Promise<TenantProfile[]> {
    return (await this.getData()).tenants;
  }

  async getTenant(tenantId: string): Promise<TenantProfile | undefined> {
    return (await this.getData()).tenants.find((tenant) => tenant.id === tenantId);
  }

  async upsertTenant(input: {
    id: string;
    name?: string;
    hubBaseUrl?: string;
    entryBaseUrl?: string;
    openaiCompatibleBaseUrl?: string;
  }): Promise<TenantProfile> {
    const data = await this.getData();
    const now = new Date().toISOString();
    const index = data.tenants.findIndex((tenant) => tenant.id === input.id);

    if (index === -1) {
      const tenant: TenantProfile = {
        id: input.id,
        name: input.name ?? input.id,
        hubBaseUrl: input.hubBaseUrl,
        entryBaseUrl: input.entryBaseUrl,
        openaiCompatibleBaseUrl: input.openaiCompatibleBaseUrl,
        keyRegistry: createEmptyRegistry(),
        createdAt: now,
        updatedAt: now
      };
      data.tenants.push(tenant);
      if (!data.activeTenantId) {
        data.activeTenantId = tenant.id;
      }
      await this.writeData(data);
      return tenant;
    }

    const current = data.tenants[index];
    const updated: TenantProfile = {
      ...current,
      name: input.name ?? current.name,
      hubBaseUrl: input.hubBaseUrl ?? current.hubBaseUrl,
      entryBaseUrl: input.entryBaseUrl ?? current.entryBaseUrl,
      openaiCompatibleBaseUrl: input.openaiCompatibleBaseUrl ?? current.openaiCompatibleBaseUrl,
      keyRegistry: cloneRegistry(current.keyRegistry),
      updatedAt: now
    };

    data.tenants[index] = updated;
    await this.writeData(data);
    return updated;
  }

  async removeTenant(tenantId: string): Promise<void> {
    const data = await this.getData();
    const next = data.tenants.filter((tenant) => tenant.id !== tenantId);
    data.tenants = next;

    if (data.activeTenantId === tenantId) {
      data.activeTenantId = next[0]?.id;
    }

    await this.writeData(data);
  }

  async setActiveTenant(tenantId: string): Promise<void> {
    const data = await this.getData();
    const tenant = data.tenants.find((item) => item.id === tenantId);
    if (!tenant) {
      throw new Error(`Unknown tenant: ${tenantId}`);
    }
    data.activeTenantId = tenantId;
    await this.writeData(data);
  }

  async getActiveTenant(): Promise<TenantProfile | undefined> {
    const data = await this.getData();
    if (!data.activeTenantId) {
      return undefined;
    }
    return data.tenants.find((tenant) => tenant.id === data.activeTenantId);
  }

  async setGlobalLLM(update: LLMProfileUpdate): Promise<ProfileStoreData> {
    const data = await this.getData();
    if (update.provider) {
      data.globalDefaultLLMProvider = update.provider;
    }
    if (update.model !== undefined) {
      data.globalDefaultLLMModel = update.model;
    }
    await this.writeData(data);
    return data;
  }

  async setTenantLLM(tenantId: string, update: LLMProfileUpdate): Promise<TenantProfile> {
    const data = await this.getData();
    const index = data.tenants.findIndex((tenant) => tenant.id === tenantId);
    if (index === -1) {
      throw new Error(`Unknown tenant: ${tenantId}`);
    }

    const tenant = data.tenants[index];
    const updated: TenantProfile = {
      ...tenant,
      defaultLLMProvider: update.provider ?? tenant.defaultLLMProvider,
      defaultLLMModel: update.model !== undefined ? update.model : tenant.defaultLLMModel,
      keyRegistry: cloneRegistry(tenant.keyRegistry),
      updatedAt: new Date().toISOString()
    };

    data.tenants[index] = updated;
    await this.writeData(data);
    return updated;
  }

  async listKeySlots(tenantId: string, provider?: SecretProvider): Promise<ApiKeySlotMeta[]> {
    const tenant = await this.getRequiredTenant(tenantId);
    const all = tenant.keyRegistry.slots;
    return provider ? all.filter((slot) => slot.provider === provider) : all;
  }

  async addKeySlot(tenantId: string, input: { provider: SecretProvider; name: string; slotId?: string; fingerprint: string }): Promise<ApiKeySlotMeta> {
    const data = await this.getData();
    const { tenant, index } = this.getRequiredTenantFromData(data, tenantId);
    const registry = cloneRegistry(tenant.keyRegistry);
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
    if (!registry.activeSlotByProvider[input.provider]) {
      registry.activeSlotByProvider[input.provider] = slotId;
    }

    data.tenants[index] = {
      ...tenant,
      keyRegistry: registry,
      updatedAt: now
    };
    await this.writeData(data);
    return slot;
  }

  async updateKeySlot(
    tenantId: string,
    provider: SecretProvider,
    slotRef: string,
    update: { name?: string; fingerprint?: string; lastValidatedAt?: string }
  ): Promise<ApiKeySlotMeta> {
    const data = await this.getData();
    const { tenant, index } = this.getRequiredTenantFromData(data, tenantId);
    const registry = cloneRegistry(tenant.keyRegistry);
    const slotIndex = registry.slots.findIndex((slot) => slot.provider === provider && matchesSlotRef(slot, slotRef));
    if (slotIndex === -1) {
      throw new Error(`Unknown slot "${slotRef}" for provider ${provider}.`);
    }

    const slot = registry.slots[slotIndex];
    const nextName = update.name !== undefined ? ensureSlotName(update.name) : slot.name;
    if (nextName.toLowerCase() !== slot.name.toLowerCase()) {
      const duplicate = registry.slots.some(
        (item, idx) => idx !== slotIndex && item.provider === provider && item.name.toLowerCase() === nextName.toLowerCase()
      );
      if (duplicate) {
        throw new Error(`A key slot named "${nextName}" already exists for provider ${provider}.`);
      }
    }

    const updated: ApiKeySlotMeta = {
      ...slot,
      name: nextName,
      fingerprint: update.fingerprint ?? slot.fingerprint,
      lastValidatedAt: update.lastValidatedAt ?? slot.lastValidatedAt,
      updatedAt: new Date().toISOString()
    };
    registry.slots[slotIndex] = updated;

    data.tenants[index] = {
      ...tenant,
      keyRegistry: registry,
      updatedAt: updated.updatedAt
    };
    await this.writeData(data);
    return updated;
  }

  async removeKeySlot(tenantId: string, provider: SecretProvider, slotRef: string): Promise<void> {
    const data = await this.getData();
    const { tenant, index } = this.getRequiredTenantFromData(data, tenantId);
    const registry = cloneRegistry(tenant.keyRegistry);
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

    data.tenants[index] = {
      ...tenant,
      keyRegistry: registry,
      updatedAt: new Date().toISOString()
    };
    await this.writeData(data);
  }

  async getActiveKeySlot(tenantId: string, provider: SecretProvider): Promise<ApiKeySlotMeta | undefined> {
    const tenant = await this.getRequiredTenant(tenantId);
    const registry = tenant.keyRegistry;
    const activeSlotId = registry.activeSlotByProvider[provider];
    if (activeSlotId) {
      const match = registry.slots.find((slot) => slot.provider === provider && slot.slotId === activeSlotId);
      if (match) {
        return match;
      }
    }
    return registry.slots.find((slot) => slot.provider === provider);
  }

  async setActiveKeySlot(tenantId: string, provider: SecretProvider, slotRef: string): Promise<ApiKeySlotMeta> {
    const data = await this.getData();
    const { tenant, index } = this.getRequiredTenantFromData(data, tenantId);
    const registry = cloneRegistry(tenant.keyRegistry);
    const slot = registry.slots.find((item) => item.provider === provider && matchesSlotRef(item, slotRef));
    if (!slot) {
      throw new Error(`Unknown slot "${slotRef}" for provider ${provider}.`);
    }

    registry.activeSlotByProvider[provider] = slot.slotId;
    const now = new Date().toISOString();
    data.tenants[index] = {
      ...tenant,
      keyRegistry: registry,
      updatedAt: now
    };
    await this.writeData(data);
    return slot;
  }

  private normalize(input: ProfileStoreData): ProfileStoreData {
    const tenants = (Array.isArray(input.tenants) ? input.tenants : [])
      .filter((tenant): tenant is TenantProfile => Boolean(tenant?.id))
      .map((tenant) => normalizeTenant(tenant));

    return {
      version: 2,
      globalDefaultLLMProvider: input.globalDefaultLLMProvider ?? 'openai',
      globalDefaultLLMModel: input.globalDefaultLLMModel,
      activeTenantId: input.activeTenantId,
      tenants
    };
  }

  private async writeData(data: ProfileStoreData): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  }

  private async getRequiredTenant(tenantId: string): Promise<TenantProfile> {
    const tenant = await this.getTenant(tenantId);
    if (!tenant) {
      throw new Error(`Unknown tenant: ${tenantId}`);
    }
    return tenant;
  }

  private getRequiredTenantFromData(data: ProfileStoreData, tenantId: string): { tenant: TenantProfile; index: number } {
    const index = data.tenants.findIndex((tenant) => tenant.id === tenantId);
    if (index === -1) {
      throw new Error(`Unknown tenant: ${tenantId}`);
    }
    return {
      tenant: data.tenants[index],
      index
    };
  }
}
