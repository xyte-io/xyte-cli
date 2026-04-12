import type { ProfileStore, SecretStore } from '../types/stores';
import type { SecretProvider } from '../types/profile';
import { SUPPORTED_SECRET_PROVIDERS, PROVIDER_ORG } from '../types/profile';

interface ConfigProviderRow {
  provider: SecretProvider;
  slotCount: number;
  activeSlot: string;
  hasSecret: 'yes' | 'no';
  lastValidatedAt?: string;
}

interface ConfigSlotRow {
  provider: SecretProvider;
  slotId: string;
  name: string;
  active: 'yes' | 'no';
  hasSecret: 'yes' | 'no';
  fingerprint: string;
}

export interface ConfigData {
  providerRows: ConfigProviderRow[];
  selectedProvider: SecretProvider;
  slotRows: ConfigSlotRow[];
}

/**
 * Infrastructure-tier loader: takes store primitives directly rather than a XyteClient.
 * Intentionally differs from fleet-tier loaders (loadDevicesData, loadSpaceDrilldownData, etc.)
 * which follow the (client, tenantId, options) convention.
 */
export async function readConfigData(
  profileStore: ProfileStore,
  secretStore: SecretStore,
  tenantId: string | undefined
): Promise<ConfigData> {
  const allSlots = tenantId ? await profileStore.listKeySlots(tenantId) : [];

  const providerRows: ConfigProviderRow[] = await Promise.all(
    SUPPORTED_SECRET_PROVIDERS.map(async (provider) => {
      const providerSlots = allSlots.filter((slot) => slot.provider === provider);
      const activeSlot = tenantId ? await profileStore.getActiveKeySlot(tenantId, provider) : undefined;
      const hasActiveSecret =
        tenantId && activeSlot
          ? Boolean(await secretStore.getSlotSecret(tenantId, provider, activeSlot.slotId))
          : false;
      return {
        provider,
        slotCount: providerSlots.length,
        activeSlot: activeSlot?.slotId ?? 'none',
        hasSecret: hasActiveSecret ? 'yes' : 'no',
        lastValidatedAt: activeSlot?.lastValidatedAt
      };
    })
  );

  const selectedProvider = providerRows.find((row) => row.slotCount > 0)?.provider ?? PROVIDER_ORG;

  const slotRows: ConfigSlotRow[] = await Promise.all(
    allSlots
      .filter((slot) => slot.provider === selectedProvider)
      .map(async (slot) => {
        const active = tenantId ? await profileStore.getActiveKeySlot(tenantId, slot.provider) : undefined;
        const hasSecret = tenantId
          ? Boolean(await secretStore.getSlotSecret(tenantId, slot.provider, slot.slotId))
          : false;
        return {
          provider: slot.provider,
          slotId: slot.slotId,
          name: slot.name,
          active: active?.slotId === slot.slotId ? 'yes' : 'no',
          hasSecret: hasSecret ? 'yes' : 'no',
          fingerprint: slot.fingerprint
        };
      })
  );

  return { providerRows, selectedProvider, slotRows };
}
