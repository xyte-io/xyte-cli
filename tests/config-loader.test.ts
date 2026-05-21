import { describe, expect, it } from 'vitest';

import { readConfigData } from '../src/tui/config-loader';
import { PROVIDER_ORG } from '../src/types/profile';

function makeProfileStore(overrides: Partial<{
  listKeySlots: () => Promise<any[]>;
  getActiveKeySlot: () => Promise<any>;
}> = {}) {
  return {
    listKeySlots: async () => [],
    getActiveKeySlot: async () => undefined,
    ...overrides
  } as any;
}

function makeSecretStore(hasSecret = false) {
  return {
    getSlotSecret: async () => (hasSecret ? 'secret-value' : undefined)
  } as any;
}

describe('readConfigData', () => {
  it('returns empty rows when tenantId is undefined', async () => {
    const result = await readConfigData(makeProfileStore(), makeSecretStore(), undefined);
    expect(result.slotRows).toHaveLength(0);
    for (const row of result.providerRows) {
      expect(row.slotCount).toBe(0);
      expect(row.activeSlot).toBe('none');
      expect(row.hasSecret).toBe('no');
    }
  });

  it('defaults selectedProvider to PROVIDER_ORG when no slots exist', async () => {
    const result = await readConfigData(makeProfileStore(), makeSecretStore(), 'tenant-1');
    expect(result.selectedProvider).toBe(PROVIDER_ORG);
  });

  it('selects provider with slots over PROVIDER_ORG default', async () => {
    const profileStore = makeProfileStore({
      listKeySlots: async () => [
        { provider: 'xyte-partner', slotId: 'slot-1', name: 'Slot 1', fingerprint: 'fp1' }
      ],
      getActiveKeySlot: async () => undefined
    });
    const result = await readConfigData(profileStore, makeSecretStore(), 'tenant-1');
    expect(result.selectedProvider).toBe('xyte-partner');
  });

  it('marks active slot correctly', async () => {
    const profileStore = makeProfileStore({
      listKeySlots: async () => [
        { provider: 'xyte-org', slotId: 'slot-a', name: 'Slot A', fingerprint: 'fp-a' },
        { provider: 'xyte-org', slotId: 'slot-b', name: 'Slot B', fingerprint: 'fp-b' }
      ],
      getActiveKeySlot: async () => ({ slotId: 'slot-a', lastValidatedAt: '2024-01-01' })
    });
    const result = await readConfigData(profileStore, makeSecretStore(true), 'tenant-1');
    const active = result.slotRows.find((r) => r.slotId === 'slot-a');
    const inactive = result.slotRows.find((r) => r.slotId === 'slot-b');
    expect(active?.active).toBe('yes');
    expect(inactive?.active).toBe('no');
  });

  it('reports hasSecret correctly based on secret store', async () => {
    const profileStore = makeProfileStore({
      listKeySlots: async () => [
        { provider: 'xyte-org', slotId: 'slot-1', name: 'S1', fingerprint: 'fp1' }
      ],
      getActiveKeySlot: async () => ({ slotId: 'slot-1' })
    });
    const withSecret = await readConfigData(profileStore, makeSecretStore(true), 'tenant-1');
    const withoutSecret = await readConfigData(profileStore, makeSecretStore(false), 'tenant-1');
    expect(withSecret.providerRows.find((r) => r.provider === 'xyte-org')?.hasSecret).toBe('yes');
    expect(withoutSecret.providerRows.find((r) => r.provider === 'xyte-org')?.hasSecret).toBe('no');
  });
});
