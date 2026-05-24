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
    };

    const client = createXyteClient({ profileStore, secretStore, transport: transport as unknown as HttpTransport });
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
    };

    await profileStore.addKeySlot('acme', 'xyte-org', {
      name: 'missing-secret',
      fingerprint: 'sha256:none'
    });

    const client = createXyteClient({ profileStore, secretStore, transport: transport as unknown as HttpTransport });
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
    };

    const client = createXyteClient({ profileStore, secretStore, transport: transport as unknown as HttpTransport });
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

  it('does not send a body for organization device incident controls', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { success: true } });
    const transport = { request } as unknown as HttpTransport;

    const client = createXyteClient({
      auth: { organization: 'org-key-123' },
      hubBaseUrl: 'https://hub.example.test',
      transport
    });
    await client.organization.suspendIncidents({
      path: { device_id: 'dev-1' },
      body: { ignored: true }
    });

    expect(request).toHaveBeenCalledTimes(1);
    const sent = request.mock.calls[0][0];
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('https://hub.example.test/core/v1/organization/devices/dev-1/suspend_incidents');
    expect(sent.body).toBeUndefined();
    expect(sent.headers['Content-Type']).toBeUndefined();
  });

  it('builds query URLs for organization users and edges collection endpoints', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { items: [] } });
    const transport = { request } as unknown as HttpTransport;

    const client = createXyteClient({
      auth: { organization: 'org-key-123' },
      hubBaseUrl: 'https://hub.example.test',
      transport
    });
    await client.organization.getUsers({ query: { page: 2, per_page: 50 } });
    await client.organization.getEdges({ query: { page: 1, per_page: 25 } });

    expect(request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'GET',
        url: 'https://hub.example.test/core/v1/organization/users?page=2&per_page=50',
        body: undefined
      })
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'GET',
        url: 'https://hub.example.test/core/v1/organization/edges?page=1&per_page=25',
        body: undefined
      })
    );
  });

  it('sends JSON bodies for organization group membership writes', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, headers: {}, data: { ok: true } });
    const transport = { request } as unknown as HttpTransport;

    const client = createXyteClient({
      auth: { organization: 'org-key-123' },
      hubBaseUrl: 'https://hub.example.test',
      transport
    });
    await client.organization.addUsers({
      path: { id: 'group-1' },
      body: { user_ids: ['user-1'] }
    });

    expect(request).toHaveBeenCalledTimes(1);
    const sent = request.mock.calls[0][0];
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('https://hub.example.test/core/v1/organization/groups/group-1/add_users');
    expect(sent.body).toBe('{"user_ids":["user-1"]}');
    expect(sent.headers['Content-Type']).toBe('application/json');
  });

  it('sends partner organization creation through the partner auth scope', async () => {
    const request = vi.fn().mockResolvedValue({ status: 201, headers: {}, data: { id: 'org-1' } });
    const transport = { request } as unknown as HttpTransport;

    const client = createXyteClient({
      auth: { partner: 'partner-key-456' },
      hubBaseUrl: 'https://hub.example.test',
      transport
    });
    await client.partner.createOrganization({
      body: {
        name: 'Acme HQ',
        admin_contact_email: 'admin@example.com',
        admin_contact_name: 'Jane Doe'
      }
    });

    expect(request).toHaveBeenCalledTimes(1);
    const sent = request.mock.calls[0][0];
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('https://hub.example.test/core/v1/partner/organizations');
    expect(sent.headers.Authorization).toBe('partner-key-456');
    expect(sent.body).toBe(
      '{"name":"Acme HQ","admin_contact_email":"admin@example.com","admin_contact_name":"Jane Doe"}'
    );
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
    };

    const client = createXyteClient({ profileStore, secretStore, transport: transport as unknown as HttpTransport });
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
    };

    const client = createXyteClient({ profileStore, secretStore, transport: transport as unknown as HttpTransport });
    await client.organization.getDevices();

    expect(transport.request.mock.calls[0][0].headers.Authorization).toBe('org-key-file');
  });
});
