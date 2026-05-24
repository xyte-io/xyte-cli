import { describe, expect, it } from 'vitest';

import { evaluateReadiness } from '../../src/config/readiness';
import { MemorySecretStore } from '../../src/secure/secret-store';
import { MemoryProfileStore } from '../support/memory-profile-store';

describe('readiness evaluation', () => {
  it('returns needs_setup when no active tenant exists', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();

    const readiness = await evaluateReadiness({
      profileStore,
      secretStore,
      checkConnectivity: false
    });

    expect(readiness.state).toBe('needs_setup');
    expect(readiness.missingItems.length).toBeGreaterThan(0);
  });

  it('returns ready when tenant and active Xyte key are configured', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const slot = await profileStore.addKeySlot('acme', 'xyte-org', {
      
      name: 'primary',
      fingerprint: 'sha256:test'
    });
    await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key');

    const client: any = {
      organization: { getOrganizationInfo: async () => ({ ok: true }) },
      partner: { getDevices: async () => [] }
    };

    const readiness = await evaluateReadiness({
      profileStore,
      secretStore,
      client,
      checkConnectivity: true
    });

    expect(readiness.state).toBe('ready');
    expect(readiness.connectionState).toBe('connected');
  });

  it('returns degraded on transient connectivity failure', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const slot = await profileStore.addKeySlot('acme', 'xyte-org', {
      
      name: 'primary',
      fingerprint: 'sha256:test'
    });
    await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key');

    const client: any = {
      organization: { getOrganizationInfo: async () => Promise.reject(new TypeError('fetch failed')) },
      partner: { getDevices: async () => Promise.reject(new TypeError('fetch failed')) }
    };

    const readiness = await evaluateReadiness({
      profileStore,
      secretStore,
      client,
      checkConnectivity: true
    });

    expect(readiness.state).toBe('degraded');
    expect(readiness.connectionState).toBe('network_error');
  });
});
