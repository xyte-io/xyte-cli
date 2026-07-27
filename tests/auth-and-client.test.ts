import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createXyteClient } from '../src/client/create-client';
import { createSecretStore, MemorySecretStore } from '../src/secure/secret-store';
import { XyteAuthError } from '../src/http/errors';
import type { HttpTransport } from '../src/http/transport';
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
    // The hub reads this header to record the call's originating client
    expect(transport.request.mock.calls[0][0].headers['X-Xyte-Client']).toMatch(/^xyte-cli\/\d+\.\d+\.\d+/);
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

  it('does not send a body for organization command reads', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { items: [] } });
    const transport = { request } as unknown as HttpTransport;

    const client = createXyteClient({
      auth: { organization: 'org-key-123' },
      hubBaseUrl: 'https://hub.example.test',
      transport
    });
    await client.organization.getCommands({
      path: { device_id: 'dev-1' },
      query: { status: 'pending' },
      body: { device_id: 'dev-1' }
    });

    expect(request).toHaveBeenCalledTimes(1);
    const sent = request.mock.calls[0][0];
    expect(sent.method).toBe('GET');
    expect(sent.url).toBe('https://hub.example.test/core/v1/organization/devices/dev-1/commands?status=pending');
    expect(sent.body).toBeUndefined();
    expect(sent.headers['Content-Type']).toBeUndefined();
  });

  it('uses the callable partner ticket path without the docs copy suffix', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { id: 'ticket-1' } });
    const transport = { request } as unknown as HttpTransport;

    const client = createXyteClient({
      auth: { partner: 'partner-key-456' },
      hubBaseUrl: 'https://hub.example.test',
      transport
    });
    await client.partner.getTicket({ path: { ticket_id: 'ticket-1' } });

    expect(request).toHaveBeenCalledTimes(1);
    const sent = request.mock.calls[0][0];
    expect(sent.method).toBe('GET');
    expect(sent.url).toBe('https://hub.example.test/core/v1/partner/tickets/ticket-1');
    expect(sent.body).toBeUndefined();
  });

  it('renders organization merge and split device requests', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } });
    const transport = { request } as unknown as HttpTransport;

    const client = createXyteClient({
      auth: { organization: 'org-key-123' },
      hubBaseUrl: 'https://hub.example.test',
      transport
    });

    await client.organization.mergeDevice({
      path: { device_id: 'primary/one' },
      body: { with_device_ids: ['shadow-1', 'shadow-2'] }
    });
    await client.organization.splitDevice({
      path: { device_id: 'primary/one' },
      body: { shadow_device_id: 'shadow-1' }
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      url: 'https://hub.example.test/core/v1/organization/devices/primary%2Fone/merge',
      body: JSON.stringify({ with_device_ids: ['shadow-1', 'shadow-2'] })
    });
    expect(request.mock.calls[0][0].headers.Authorization).toBe('org-key-123');
    expect(request.mock.calls[0][0].headers['Content-Type']).toBe('application/json');
    expect(request.mock.calls[1][0]).toMatchObject({
      method: 'POST',
      url: 'https://hub.example.test/core/v1/organization/devices/primary%2Fone/split',
      body: JSON.stringify({ shadow_device_id: 'shadow-1' })
    });
    expect(request.mock.calls[1][0].headers.Authorization).toBe('org-key-123');
    expect(request.mock.calls[1][0].headers['Content-Type']).toBe('application/json');
  });

  it('renders Edge model discovery, paginated devices, claim identity, and custom params update requests', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } });
    const transport = { request } as unknown as HttpTransport;

    const client = createXyteClient({
      auth: { organization: 'org-key-123' },
      hubBaseUrl: 'https://hub.example.test',
      transport
    });

    await client.organization.getModels({
      query: { page: 2, per_page: 50, search: 'Sony Pro', edge_only: true },
      body: { ignored: true }
    });
    await client.organization.getModel({
      path: { id: 'model/one' },
      body: { ignored: true }
    });
    await client.organization.getDevices({
      query: { page: 3, per_page: 100, space_id: 42 },
      body: { ignored: true }
    });
    await client.organization.startEdgeClaim({
      body: {
        proxy_id: 'proxy-1',
        device_ip: '10.0.0.10',
        device_model_id: 'model-1',
        space_id: 42,
        mac: 'aa:bb:cc:dd:ee:ff',
        sn: 'SN-123'
      }
    });
    await client.organization.updateDevice({
      path: { device_id: 'device/one' },
      body: { custom_parameters: { Port: '161' } }
    });

    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      url: 'https://hub.example.test/core/v1/organization/models?page=2&per_page=50&search=Sony+Pro&edge_only=true'
    });
    expect(request.mock.calls[0][0].body).toBeUndefined();
    expect(request.mock.calls[0][0].headers.Authorization).toBe('org-key-123');
    expect(request.mock.calls[0][0].headers['Content-Type']).toBeUndefined();

    expect(request.mock.calls[1][0]).toMatchObject({
      method: 'GET',
      url: 'https://hub.example.test/core/v1/organization/models/model%2Fone'
    });
    expect(request.mock.calls[1][0].body).toBeUndefined();
    expect(request.mock.calls[1][0].headers['Content-Type']).toBeUndefined();

    expect(request.mock.calls[2][0]).toMatchObject({
      method: 'GET',
      url: 'https://hub.example.test/core/v1/organization/devices?page=3&per_page=100&space_id=42'
    });
    expect(request.mock.calls[2][0].body).toBeUndefined();
    expect(request.mock.calls[2][0].headers['Content-Type']).toBeUndefined();

    expect(request.mock.calls[3][0]).toMatchObject({
      method: 'POST',
      url: 'https://hub.example.test/core/v1/organization/edges/devices/start_claim',
      body: JSON.stringify({
        proxy_id: 'proxy-1',
        device_ip: '10.0.0.10',
        device_model_id: 'model-1',
        space_id: 42,
        mac: 'aa:bb:cc:dd:ee:ff',
        sn: 'SN-123'
      })
    });
    expect(request.mock.calls[3][0].headers.Authorization).toBe('org-key-123');
    expect(request.mock.calls[3][0].headers['Content-Type']).toBe('application/json');

    expect(request.mock.calls[4][0]).toMatchObject({
      method: 'PATCH',
      url: 'https://hub.example.test/core/v1/organization/devices/device%2Fone',
      body: JSON.stringify({ custom_parameters: { Port: '161' } })
    });
    expect(request.mock.calls[4][0].headers.Authorization).toBe('org-key-123');
    expect(request.mock.calls[4][0].headers['Content-Type']).toBe('application/json');
  });

  it('renders organization note requests with path, pagination, and body semantics', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } });
    const transport = { request } as unknown as HttpTransport;

    const client = createXyteClient({
      auth: { organization: 'org-key-123' },
      hubBaseUrl: 'https://hub.example.test',
      transport
    });

    await client.organization.createDeviceNote({
      path: { device_id: 'device/one' },
      body: { content: 'Mounted behind the left panel.' }
    });
    await client.organization.createSpaceNote({
      path: { space_id: 'space/one' },
      body: { content: 'Badge escort required.' }
    });
    await client.organization.getAllDeviceNotes({
      query: { page: 2, per_page: 50 }
    });
    await client.organization.getAllSpaceNotes({
      query: { page: 3, per_page: 25 }
    });
    await client.organization.getDeviceNotes({
      path: { device_id: 'device/one' },
      query: { page: 1, per_page: 100 }
    });
    await client.organization.getSpaceNotes({
      path: { space_id: 'space/one' },
      query: { page: 4, per_page: 10 }
    });
    await client.organization.deleteDeviceNote({
      path: { device_id: 'device/one', id: 'note/one' },
      body: { ignored: true }
    });
    await client.organization.deleteSpaceNote({
      path: { space_id: 'space/one', id: 'note/two' },
      body: { ignored: true }
    });

    expect(request).toHaveBeenCalledTimes(8);
    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      url: 'https://hub.example.test/core/v1/organization/devices/device%2Fone/notes',
      body: JSON.stringify({ content: 'Mounted behind the left panel.' })
    });
    expect(request.mock.calls[0][0].headers.Authorization).toBe('org-key-123');
    expect(request.mock.calls[0][0].headers['Content-Type']).toBe('application/json');

    expect(request.mock.calls[1][0]).toMatchObject({
      method: 'POST',
      url: 'https://hub.example.test/core/v1/organization/spaces/space%2Fone/notes',
      body: JSON.stringify({ content: 'Badge escort required.' })
    });
    expect(request.mock.calls[1][0].headers.Authorization).toBe('org-key-123');
    expect(request.mock.calls[1][0].headers['Content-Type']).toBe('application/json');

    expect(request.mock.calls[2][0]).toMatchObject({
      method: 'GET',
      url: 'https://hub.example.test/core/v1/organization/devices/notes?page=2&per_page=50'
    });
    expect(request.mock.calls[2][0].body).toBeUndefined();
    expect(request.mock.calls[2][0].headers['Content-Type']).toBeUndefined();

    expect(request.mock.calls[3][0]).toMatchObject({
      method: 'GET',
      url: 'https://hub.example.test/core/v1/organization/spaces/notes?page=3&per_page=25'
    });
    expect(request.mock.calls[3][0].body).toBeUndefined();
    expect(request.mock.calls[3][0].headers['Content-Type']).toBeUndefined();

    expect(request.mock.calls[4][0]).toMatchObject({
      method: 'GET',
      url: 'https://hub.example.test/core/v1/organization/devices/device%2Fone/notes?page=1&per_page=100'
    });
    expect(request.mock.calls[4][0].body).toBeUndefined();
    expect(request.mock.calls[4][0].headers['Content-Type']).toBeUndefined();

    expect(request.mock.calls[5][0]).toMatchObject({
      method: 'GET',
      url: 'https://hub.example.test/core/v1/organization/spaces/space%2Fone/notes?page=4&per_page=10'
    });
    expect(request.mock.calls[5][0].body).toBeUndefined();
    expect(request.mock.calls[5][0].headers['Content-Type']).toBeUndefined();

    expect(request.mock.calls[6][0]).toMatchObject({
      method: 'DELETE',
      url: 'https://hub.example.test/core/v1/organization/devices/device%2Fone/notes/note%2Fone'
    });
    expect(request.mock.calls[6][0].body).toBeUndefined();
    expect(request.mock.calls[6][0].headers['Content-Type']).toBeUndefined();

    expect(request.mock.calls[7][0]).toMatchObject({
      method: 'DELETE',
      url: 'https://hub.example.test/core/v1/organization/spaces/space%2Fone/notes/note%2Ftwo'
    });
    expect(request.mock.calls[7][0].body).toBeUndefined();
    expect(request.mock.calls[7][0].headers['Content-Type']).toBeUndefined();
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
