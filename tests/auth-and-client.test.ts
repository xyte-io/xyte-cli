import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createXyteClient } from '../src/client/create-client';
import { createSecretStore, MemorySecretStore } from '../src/secure/secret-store';
import { XyteAuthError } from '../src/http/errors';
import { MemoryProfileStore } from './support/memory-profile-store';

describe('client auth behavior', () => {
  it('injects organization auth header from tenant secretStore', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const secretStore = new MemorySecretStore();
    const slot = await profileStore.addKeySlot('acme', 'xyte-org', {
      
      name: 'primary',
      fingerprint: 'sha256:org'
    });
    await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key-123');

    const transport = {
      request: vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } })
    } as any;

    const client = createXyteClient({ profileStore, secretStore, transport });
    await client.organization.getDevices();

    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(transport.request.mock.calls[0][0].headers.Authorization).toBe('org-key-123');
    expect(transport.request.mock.calls[0][0].headers['User-Agent']).toBe('CLI');
  });

  it('throws auth error when scoped key is missing', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const secretStore = new MemorySecretStore();
    const transport = {
      request: vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } })
    } as any;

    await profileStore.addKeySlot('acme', 'xyte-org', {
      
      name: 'missing-secret',
      fingerprint: 'sha256:none'
    });

    const client = createXyteClient({ profileStore, secretStore, transport });
    await expect(client.organization.getDevices()).rejects.toBeInstanceOf(XyteAuthError);
  });

  it('injects partner auth header from tenant secretStore', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const secretStore = new MemorySecretStore();
    const slot = await profileStore.addKeySlot('acme', 'xyte-partner', {
      
      name: 'partner-primary',
      fingerprint: 'sha256:partner'
    });
    await secretStore.setSlotSecret('acme', 'xyte-partner', slot.slotId, 'partner-key-456');

    const transport = {
      request: vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } })
    } as any;

    const client = createXyteClient({ profileStore, secretStore, transport });
    await client.partner.getDevices();

    expect(transport.request).toHaveBeenCalledTimes(1);
    expect(transport.request.mock.calls[0][0].headers.Authorization).toBe('partner-key-456');
  });

  it('uses active slot secret when multiple slots exist', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const secretStore = new MemorySecretStore();
    const slotA = await profileStore.addKeySlot('acme', 'xyte-org', {
      
      name: 'slot-a',
      fingerprint: 'sha256:a'
    });
    const slotB = await profileStore.addKeySlot('acme', 'xyte-org', {
      
      name: 'slot-b',
      fingerprint: 'sha256:b'
    });
    await secretStore.setSlotSecret('acme', 'xyte-org', slotA.slotId, 'org-key-a');
    await secretStore.setSlotSecret('acme', 'xyte-org', slotB.slotId, 'org-key-b');
    await profileStore.setActiveKeySlot('acme', 'xyte-org', slotB.slotId);

    const transport = {
      request: vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } })
    } as any;

    const client = createXyteClient({ profileStore, secretStore, transport });
    await client.organization.getDevices();

    expect(transport.request.mock.calls[0][0].headers.Authorization).toBe('org-key-b');
  });

  it('injects auth headers from the selected persisted file backend', async () => {
    const profileStore = new MemoryProfileStore();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const configDir = mkdtempSync(join(tmpdir(), 'xyte-client-file-backend-'));
    const secretStore = createSecretStore({
      env: {
        ...process.env,
        XYTE_CLI_CONFIG_DIR: configDir,
        XYTE_CLI_SECRET_STORE_BACKEND: 'file'
      },
      platform: 'linux'
    });
    const slot = await profileStore.addKeySlot('acme', 'xyte-org', {
      name: 'primary',
      fingerprint: 'sha256:file'
    });
    await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key-file');

    const transport = {
      request: vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } })
    } as any;

    const client = createXyteClient({ profileStore, secretStore, transport });
    await client.organization.getDevices();

    expect(transport.request.mock.calls[0][0].headers.Authorization).toBe('org-key-file');
  });
});
