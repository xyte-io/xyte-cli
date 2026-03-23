import { mkdtempSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { FileProfileStore } from '../src/secure/profile-store';

describe('profile store migration', () => {
  it('auto-purges unsupported provider slots and active pointers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xyte-profile-store-legacy-'));
    const filePath = join(root, 'profile.json');
    const legacyProfile = {
      version: 2,
      activeTenantId: 'acme',
      tenants: [
        {
          id: 'acme',
          name: 'Acme',
          keyRegistry: {
            slots: [
              {
                slotId: 'org-primary',
                provider: 'xyte-org',
                name: 'primary',
                fingerprint: 'sha256:org',
                createdAt: '2026-02-01T00:00:00.000Z',
                updatedAt: '2026-02-01T00:00:00.000Z'
              },
              {
                slotId: 'device-edge',
                provider: 'xyte-device',
                name: 'edge',
                fingerprint: 'sha256:device',
                createdAt: '2026-02-01T00:00:00.000Z',
                updatedAt: '2026-02-01T00:00:00.000Z'
              }
            ],
            activeSlotByProvider: {
              'xyte-org': 'org-primary',
              'xyte-device': 'device-edge'
            }
          },
          createdAt: '2026-02-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z'
        }
      ]
    } as any;
    writeFileSync(filePath, `${JSON.stringify(legacyProfile, null, 2)}\n`, 'utf8');

    const store = new FileProfileStore(filePath);
    const data = await store.getData();
    expect(data.activeTenantId).toBe('acme');
    const tenant = data.tenants[0];
    expect(tenant.keyRegistry.slots.map((slot) => slot.provider)).toEqual(['xyte-org']);
    expect(tenant.keyRegistry.activeSlotByProvider['xyte-org']).toBe('org-primary');
    expect((tenant.keyRegistry.activeSlotByProvider as Record<string, string>)['xyte-device']).toBeUndefined();

    await store.migrateIfNeeded();
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as any;
    const providers = persisted.tenants[0].keyRegistry.slots.map((slot: { provider: string }) => slot.provider);
    expect(providers).toEqual(['xyte-org']);
    expect(persisted.tenants[0].keyRegistry.activeSlotByProvider['xyte-device']).toBeUndefined();
  });

  it('backfills tenant apiProvider when legacy data has one configured provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xyte-profile-store-provider-backfill-'));
    const filePath = join(root, 'profile.json');
    writeFileSync(
      filePath,
      `${JSON.stringify(
        {
          version: 2,
          activeTenantId: 'acme',
          tenants: [
            {
              id: 'acme',
              name: 'Acme',
              keyRegistry: {
                slots: [
                  {
                    slotId: 'partner-primary',
                    provider: 'xyte-partner',
                    name: 'primary',
                    fingerprint: 'sha256:partner',
                    createdAt: '2026-02-01T00:00:00.000Z',
                    updatedAt: '2026-02-01T00:00:00.000Z'
                  }
                ],
                activeSlotByProvider: {
                  'xyte-partner': 'partner-primary'
                }
              },
              createdAt: '2026-02-01T00:00:00.000Z',
              updatedAt: '2026-02-01T00:00:00.000Z'
            }
          ]
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    const store = new FileProfileStore(filePath);
    const tenant = await store.getTenant('acme');
    expect(tenant?.apiProvider).toBe('xyte-partner');

    await store.migrateIfNeeded();
    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as any;
    expect(persisted.tenants[0].apiProvider).toBe('xyte-partner');
  });

  it('reassigns tenant apiProvider after removing the last slot for the current provider', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xyte-profile-store-provider-remove-'));
    const filePath = join(root, 'profile.json');
    const store = new FileProfileStore(filePath);

    await store.upsertTenant({ id: 'acme', apiProvider: 'xyte-org' });
    await store.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'org-primary',
      fingerprint: 'sha256:org'
    });
    await store.addKeySlot('acme', {
      provider: 'xyte-partner',
      name: 'partner-primary',
      fingerprint: 'sha256:partner'
    });

    await store.removeKeySlot('acme', 'xyte-org', 'org-primary');

    const tenant = await store.getTenant('acme');
    expect(tenant?.apiProvider).toBe('xyte-partner');
  });
});
