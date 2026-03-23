import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  ApiKeySlotMeta,
  ProfileStoreData,
  SecretProvider,
  TenantKeyRegistry,
  TenantProfile
} from '../types/profile';
import { SUPPORTED_SECRET_PROVIDERS, isSecretProvider } from '../types/profile';
import { getXyteConfigDir } from '../utils/config-dir';
import { errorMessage } from '../utils/error-format';
import { buildSlotId, ensureSlotName, matchesSlotRef } from './key-slots';

const DEFAULT_DATA: ProfileStoreData = {
  version: 2,
  tenants: []
};

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
  }): Promise<TenantProfile>;
  removeTenant(tenantId: string): Promise<void>;
  setActiveTenant(tenantId: string): Promise<void>;
  getActiveTenant(): Promise<TenantProfile | undefined>;
  listKeySlots(tenantId: string, provider?: SecretProvider): Promise<ApiKeySlotMeta[]>;
  addKeySlot(
    tenantId: string,
    input: { provider: SecretProvider; name: string; slotId?: string; fingerprint: string }
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

function normalizeTenant(raw: TenantProfile): { tenant: TenantProfile; changed: boolean } {
  const now = new Date().toISOString();
  const registry = cloneRegistry(raw.keyRegistry);
  let changed = false;
  const normalizedSlots: ApiKeySlotMeta[] = [];
  for (const slot of registry.slots) {
    if (!slot || typeof slot.provider !== 'string' || typeof slot.slotId !== 'string') {
      changed = true;
      continue;
    }
    if (!isSecretProvider(slot.provider)) {
      changed = true;
      continue;
    }

    const normalizedSlot: ApiKeySlotMeta = {
      slotId: slot.slotId,
      provider: slot.provider,
      name: slot.name || slot.slotId,
      fingerprint: slot.fingerprint || 'sha256:unknown',
      createdAt: slot.createdAt || now,
      updatedAt: slot.updatedAt || now,
      lastValidatedAt: slot.lastValidatedAt
    };

    if (
      normalizedSlot.name !== slot.name ||
      normalizedSlot.fingerprint !== slot.fingerprint ||
      normalizedSlot.createdAt !== slot.createdAt ||
      normalizedSlot.updatedAt !== slot.updatedAt
    ) {
      changed = true;
    }

    normalizedSlots.push(normalizedSlot);
  }

  const activeSlotByProvider: Partial<Record<SecretProvider, string>> = {};
  for (const [provider, slotId] of Object.entries(registry.activeSlotByProvider ?? {})) {
    if (!isSecretProvider(provider)) {
      changed = true;
      continue;
    }
    if (typeof slotId !== 'string') {
      changed = true;
      continue;
    }
    activeSlotByProvider[provider] = slotId;
  }

  for (const provider of SUPPORTED_SECRET_PROVIDERS) {
    const active = activeSlotByProvider[provider];
    const exists = normalizedSlots.some((slot) => slot.provider === provider && slot.slotId === active);
    if (!exists) {
      const fallback = normalizedSlots.find((slot) => slot.provider === provider)?.slotId;
      if (fallback) {
        activeSlotByProvider[provider] = fallback;
      } else {
        delete activeSlotByProvider[provider];
      }
      if (active !== fallback) {
        changed = true;
      }
    }
  }

  const tenant: TenantProfile = {
    id: raw.id,
    name: raw.name ?? raw.id,
    hubBaseUrl: raw.hubBaseUrl,
    entryBaseUrl: raw.entryBaseUrl,
    keyRegistry: {
      slots: normalizedSlots,
      activeSlotByProvider
    },
    createdAt: raw.createdAt ?? now,
    updatedAt: raw.updatedAt ?? now
  };

  if (tenant.name !== raw.name || tenant.createdAt !== raw.createdAt || tenant.updatedAt !== raw.updatedAt) {
    changed = true;
  }

  return {
    tenant,
    changed
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
      let parsed: ProfileStoreData;
      try {
        parsed = JSON.parse(content) as ProfileStoreData;
      } catch (error) {
        const detail = errorMessage(error);
        throw new Error(
          `Profile store is invalid at ${this.filePath}: ${detail}. Delete or fix this file and rerun setup.`
        );
      }
      return this.normalize(parsed).data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return structuredClone(DEFAULT_DATA);
      }
      throw error;
    }
  }

  async migrateIfNeeded(): Promise<void> {
    try {
      const content = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(content) as ProfileStoreData;
      const normalized = this.normalize(parsed);
      if (normalized.changed) {
        await this.writeData(normalized.data);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || error instanceof SyntaxError) {
        return; // No file or invalid JSON — nothing to migrate.
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

  async listKeySlots(tenantId: string, provider?: SecretProvider): Promise<ApiKeySlotMeta[]> {
    const tenant = await this.getRequiredTenant(tenantId);
    const all = tenant.keyRegistry.slots;
    return provider ? all.filter((slot) => slot.provider === provider) : all;
  }

  async addKeySlot(
    tenantId: string,
    input: { provider: SecretProvider; name: string; slotId?: string; fingerprint: string }
  ): Promise<ApiKeySlotMeta> {
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
        (item, idx) =>
          idx !== slotIndex && item.provider === provider && item.name.toLowerCase() === nextName.toLowerCase()
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

  private normalize(input: ProfileStoreData): { data: ProfileStoreData; changed: boolean } {
    let changed = false;
    const rawTenants = Array.isArray(input.tenants) ? input.tenants : [];
    if (!Array.isArray(input.tenants)) {
      changed = true;
    }

    const tenants: TenantProfile[] = [];
    for (const candidate of rawTenants) {
      if (!candidate?.id) {
        changed = true;
        continue;
      }
      const normalizedTenant = normalizeTenant(candidate);
      tenants.push(normalizedTenant.tenant);
      if (normalizedTenant.changed) {
        changed = true;
      }
    }

    const incomingActiveTenantId = typeof input.activeTenantId === 'string' ? input.activeTenantId : undefined;
    if (input.activeTenantId !== incomingActiveTenantId) {
      changed = true;
    }

    const activeTenantId =
      incomingActiveTenantId && tenants.some((tenant) => tenant.id === incomingActiveTenantId)
        ? incomingActiveTenantId
        : tenants[0]?.id;
    if (activeTenantId !== incomingActiveTenantId) {
      changed = true;
    }

    if (input.version !== 2) {
      changed = true;
    }

    return {
      data: {
        version: 2,
        activeTenantId,
        tenants
      },
      changed
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

  private getRequiredTenantFromData(
    data: ProfileStoreData,
    tenantId: string
  ): { tenant: TenantProfile; index: number } {
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

export function createProfileStore(): ProfileStore {
  return new FileProfileStore();
}
