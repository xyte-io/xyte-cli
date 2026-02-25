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

    const persisted = JSON.parse(await readFile(filePath, 'utf8')) as any;
    const providers = persisted.tenants[0].keyRegistry.slots.map((slot: { provider: string }) => slot.provider);
    expect(providers).toEqual(['xyte-org']);
    expect(persisted.tenants[0].keyRegistry.activeSlotByProvider['xyte-device']).toBeUndefined();
  });
});
