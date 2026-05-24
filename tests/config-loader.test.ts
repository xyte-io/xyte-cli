import { describe, expect, it } from 'vitest';

import { MemorySecretStore } from '../src/secure/secret-store';
import { readConfigData } from '../src/tui/config-loader';
import { PROVIDER_ORG, type SecretProvider } from '../src/types/profile';
import { MemoryProfileStore } from './support/memory-profile-store';

const TENANT_ID = 'tenant-1';

async function makeProfileStore(
  slots: Array<{
    provider: SecretProvider;
    slotId: string;
    name: string;
    fingerprint: string;
  }> = []
): Promise<MemoryProfileStore> {
  const profileStore = new MemoryProfileStore();
  await profileStore.upsertTenant({ id: TENANT_ID });
  for (const slot of slots) {
    await profileStore.addKeySlot(TENANT_ID, slot.provider, {
      slotId: slot.slotId,
      name: slot.name,
      fingerprint: slot.fingerprint
    });
  }
  return profileStore;
}

describe('readConfigData', () => {
  it('returns empty rows when tenantId is undefined', async () => {
    const result = await readConfigData(await makeProfileStore(), new MemorySecretStore(), undefined);
    expect(result.slotRows).toHaveLength(0);
    for (const row of result.providerRows) {
      expect(row.slotCount).toBe(0);
      expect(row.activeSlot).toBe('none');
      expect(row.hasSecret).toBe('no');
    }
  });

  it('defaults selectedProvider to PROVIDER_ORG when no slots exist', async () => {
    const result = await readConfigData(await makeProfileStore(), new MemorySecretStore(), TENANT_ID);
    expect(result.selectedProvider).toBe(PROVIDER_ORG);
  });

  it('selects provider with slots over PROVIDER_ORG default', async () => {
    const profileStore = await makeProfileStore([
      { provider: 'xyte-partner', slotId: 'slot-1', name: 'Slot 1', fingerprint: 'fp1' }
    ]);
    const result = await readConfigData(profileStore, new MemorySecretStore(), TENANT_ID);
    expect(result.selectedProvider).toBe('xyte-partner');
  });

  it('marks active slot correctly', async () => {
    const profileStore = await makeProfileStore([
      { provider: 'xyte-org', slotId: 'slot-a', name: 'Slot A', fingerprint: 'fp-a' },
      { provider: 'xyte-org', slotId: 'slot-b', name: 'Slot B', fingerprint: 'fp-b' }
    ]);
    const secretStore = new MemorySecretStore();
    await secretStore.setSlotSecret(TENANT_ID, 'xyte-org', 'slot-a', 'secret-value');
    const result = await readConfigData(profileStore, secretStore, TENANT_ID);
    const active = result.slotRows.find((r) => r.slotId === 'slot-a');
    const inactive = result.slotRows.find((r) => r.slotId === 'slot-b');
    expect(active?.active).toBe('yes');
    expect(inactive?.active).toBe('no');
  });

  it('reports hasSecret correctly based on secret store', async () => {
    const profileStore = await makeProfileStore([
      { provider: 'xyte-org', slotId: 'slot-1', name: 'S1', fingerprint: 'fp1' }
    ]);
    const secretStore = new MemorySecretStore();
    await secretStore.setSlotSecret(TENANT_ID, 'xyte-org', 'slot-1', 'secret-value');
    const withSecret = await readConfigData(profileStore, secretStore, TENANT_ID);
    const withoutSecret = await readConfigData(profileStore, new MemorySecretStore(), TENANT_ID);
    expect(withSecret.providerRows.find((r) => r.provider === 'xyte-org')?.hasSecret).toBe('yes');
    expect(withoutSecret.providerRows.find((r) => r.provider === 'xyte-org')?.hasSecret).toBe('no');
  });
});
