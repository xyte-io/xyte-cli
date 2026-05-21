import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { FileProfileStore } from '../src/secure/profile-store';

function makeTempStore(): FileProfileStore {
  const root = mkdtempSync(join(tmpdir(), 'xyte-profile-store-'));
  return new FileProfileStore(join(root, 'profile.json'));
}

describe('FileProfileStore CRUD', () => {
  it('upserts a tenant and makes it active when it is the first tenant', async () => {
    const store = makeTempStore();
    const tenant = await store.upsertTenant({ id: 'acme', name: 'Acme Corp' });
    expect(tenant.id).toBe('acme');
    expect(tenant.name).toBe('Acme Corp');

    const data = await store.getData();
    expect(data.activeTenantId).toBe('acme');
    expect(data.tenants).toHaveLength(1);
  });

  it('persists tenant across store reloads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xyte-profile-store-'));
    const filePath = join(root, 'profile.json');
    const store1 = new FileProfileStore(filePath);
    await store1.upsertTenant({ id: 'acme' });

    const store2 = new FileProfileStore(filePath);
    const data = await store2.getData();
    expect(data.tenants[0].id).toBe('acme');
  });

  it('adds a key slot and sets it as active for the provider', async () => {
    const store = makeTempStore();
    await store.upsertTenant({ id: 'acme' });
    const slot = await store.addKeySlot('acme', 'xyte-org', { name: 'primary', fingerprint: 'sha256:abc' });
    expect(slot.provider).toBe('xyte-org');
    expect(slot.name).toBe('primary');
    expect(slot.fingerprint).toBe('sha256:abc');

    const active = await store.getActiveKeySlot('acme', 'xyte-org');
    expect(active?.slotId).toBe(slot.slotId);
  });

  it('updates an existing key slot fingerprint', async () => {
    const store = makeTempStore();
    await store.upsertTenant({ id: 'acme' });
    const slot = await store.addKeySlot('acme', 'xyte-org', { name: 'primary', fingerprint: 'sha256:old' });
    const updated = await store.updateKeySlot('acme', 'xyte-org', slot.slotId, { fingerprint: 'sha256:new' });
    expect(updated.fingerprint).toBe('sha256:new');
    expect(updated.slotId).toBe(slot.slotId);
  });

  it('sets active key slot by slot id', async () => {
    const store = makeTempStore();
    await store.upsertTenant({ id: 'acme' });
    const slot1 = await store.addKeySlot('acme', 'xyte-org', { name: 'primary', fingerprint: 'sha256:a' });
    const slot2 = await store.addKeySlot('acme', 'xyte-org', { name: 'secondary', fingerprint: 'sha256:b' });

    await store.setActiveKeySlot('acme', 'xyte-org', slot2.slotId);
    const active = await store.getActiveKeySlot('acme', 'xyte-org');
    expect(active?.slotId).toBe(slot2.slotId);
    expect(active?.slotId).not.toBe(slot1.slotId);
  });

  it('removes a tenant and clears activeTenantId if it was active', async () => {
    const store = makeTempStore();
    await store.upsertTenant({ id: 'acme' });
    await store.upsertTenant({ id: 'other' });
    await store.setActiveTenant('acme');
    await store.removeTenant('acme');

    const data = await store.getData();
    expect(data.tenants.map((t) => t.id)).not.toContain('acme');
    expect(data.activeTenantId).not.toBe('acme');
  });
});
