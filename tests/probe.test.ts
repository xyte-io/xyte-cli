import { describe, expect, it, vi } from 'vitest';

import { runSlotConnectivityTest } from '../src/client/probe';

vi.mock('../src/client/create-client', () => {
  const makeClient = (orgHandler: () => Promise<unknown>, partnerHandler: () => Promise<unknown>) => ({
    organization: { getOrganizationInfo: orgHandler },
    partner: { getDevices: partnerHandler }
  });

  return {
    createXyteClient: vi.fn().mockImplementation(({ auth }: { auth?: { organization?: string; partner?: string } }) => {
      if (auth?.organization) {
        return makeClient(async () => ({ id: 'org-1' }), async () => { throw new Error('wrong client'); });
      }
      return makeClient(async () => { throw new Error('wrong client'); }, async () => ({ devices: [] }));
    })
  };
});

const fakeProfileStore = {} as Parameters<typeof runSlotConnectivityTest>[0]['profileStore'];

describe('runSlotConnectivityTest', () => {
  it('returns ok result for xyte-org provider', async () => {
    const result = await runSlotConnectivityTest({
      provider: 'xyte-org',
      tenantId: 'tenant-1',
      key: 'org-key',
      profileStore: fakeProfileStore
    });
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('organization.getOrganizationInfo');
  });

  it('returns ok result for xyte-partner provider', async () => {
    const result = await runSlotConnectivityTest({
      provider: 'xyte-partner',
      tenantId: 'tenant-1',
      key: 'partner-key',
      profileStore: fakeProfileStore
    });
    expect(result.ok).toBe(true);
    expect(result.strategy).toBe('partner.getDevices');
  });

  it('propagates errors from the underlying client call', async () => {
    const { createXyteClient } = await import('../src/client/create-client');
    vi.mocked(createXyteClient).mockImplementationOnce(() => ({
      organization: {
        getOrganizationInfo: async () => { throw new Error('auth error'); }
      },
      partner: { getDevices: async () => ({}) }
    }) as ReturnType<typeof createXyteClient>);

    await expect(
      runSlotConnectivityTest({
        provider: 'xyte-org',
        tenantId: 'tenant-1',
        key: 'bad-key',
        profileStore: fakeProfileStore
      })
    ).rejects.toThrow('auth error');
  });
});
