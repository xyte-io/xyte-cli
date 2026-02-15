import { describe, expect, it, vi } from 'vitest';

import { createXyteClient } from '../src/client/create-client';
import { MemoryKeychain } from '../src/secure/keychain';
import { XyteAuthError } from '../src/http/errors';
import { MemoryProfileStore } from './support/memory-profile-store';

describe('client auth behavior', () => {
  it('injects organization auth header from tenant keychain', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const keychain = new MemoryKeychain();
    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'primary',
      fingerprint: 'sha256:org'
    });
    await keychain.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key-123');

    const transport = {
      request: vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } })
    } as any;

    const client = createXyteClient({ profileStore, keychain, transport });
    await client.organization.getDevices();

    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(transport.request.mock.calls[0][0].headers.Authorization).toBe('org-key-123');
  });

  it('throws auth error when scoped key is missing', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const keychain = new MemoryKeychain();
    const transport = {
      request: vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } })
    } as any;

    await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'missing-secret',
      fingerprint: 'sha256:none'
    });

    const client = createXyteClient({ profileStore, keychain, transport });
    await expect(client.organization.getDevices()).rejects.toBeInstanceOf(XyteAuthError);
  });

  it('normalizes cloud settings payload to property/value', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const keychain = new MemoryKeychain();
    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-device',
      name: 'device-primary',
      fingerprint: 'sha256:dev'
    });
    await keychain.setSlotSecret('acme', 'xyte-device', slot.slotId, 'device-key-456');

    const transport = {
      request: vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } })
    } as any;

    const client = createXyteClient({ profileStore, keychain, transport });

    await client.device.setCloudSettings({
      path: { device_id: 'dev-1' },
      body: { 'incidents.suspend_creation': true }
    });

    const request = transport.request.mock.calls[0][0];
    expect(JSON.parse(request.body)).toEqual({
      property: 'incidents.suspend_creation',
      value: true
    });
  });

  it('uses active slot secret when multiple slots exist', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const keychain = new MemoryKeychain();
    const slotA = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'slot-a',
      fingerprint: 'sha256:a'
    });
    const slotB = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'slot-b',
      fingerprint: 'sha256:b'
    });
    await keychain.setSlotSecret('acme', 'xyte-org', slotA.slotId, 'org-key-a');
    await keychain.setSlotSecret('acme', 'xyte-org', slotB.slotId, 'org-key-b');
    await profileStore.setActiveKeySlot('acme', 'xyte-org', slotB.slotId);

    const transport = {
      request: vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } })
    } as any;

    const client = createXyteClient({ profileStore, keychain, transport });
    await client.organization.getDevices();

    expect(transport.request.mock.calls[0][0].headers.Authorization).toBe('org-key-b');
  });
});
