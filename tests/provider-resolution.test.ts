import { describe, expect, it, vi, beforeEach } from 'vitest';

import { fetchProviderForKey } from '../src/cli/provider-resolution';
import { CliUserError } from '../src/contracts/user-error';

vi.mock('../src/client/probe', () => ({
  runSlotConnectivityTest: vi.fn()
}));

import { runSlotConnectivityTest } from '../src/client/probe';

const mockRunSlot = vi.mocked(runSlotConnectivityTest);

const fakeProfileStore = {} as Parameters<typeof fetchProviderForKey>[0]['profileStore'];

beforeEach(() => {
  mockRunSlot.mockReset();
});

describe('fetchProviderForKey', () => {
  it('returns explicit provider without probing', async () => {
    const result = await fetchProviderForKey({
      profileStore: fakeProfileStore,
      tenantId: 'tenant-1',
      keyValue: 'key',
      provider: 'xyte-org',
      allowProbe: false
    });
    expect(result).toBe('xyte-org');
    expect(mockRunSlot).not.toHaveBeenCalled();
  });

  it('throws CliUserError when no provider and allowProbe is false', async () => {
    await expect(
      fetchProviderForKey({
        profileStore: fakeProfileStore,
        tenantId: 'tenant-1',
        keyValue: 'key',
        allowProbe: false
      })
    ).rejects.toThrow(CliUserError);
  });

  it('returns xyte-org when org probe succeeds', async () => {
    mockRunSlot.mockResolvedValueOnce({ strategy: 'organization.getOrganizationInfo', ok: true });
    const result = await fetchProviderForKey({
      profileStore: fakeProfileStore,
      tenantId: 'tenant-1',
      keyValue: 'key',
      allowProbe: true
    });
    expect(result).toBe('xyte-org');
    expect(mockRunSlot).toHaveBeenCalledTimes(1);
  });

  it('falls back to xyte-partner when org probe fails but partner succeeds', async () => {
    mockRunSlot.mockRejectedValueOnce(new Error('org probe failed'));
    mockRunSlot.mockResolvedValueOnce({ strategy: 'partner.getDevices', ok: true });
    const result = await fetchProviderForKey({
      profileStore: fakeProfileStore,
      tenantId: 'tenant-1',
      keyValue: 'key',
      allowProbe: true
    });
    expect(result).toBe('xyte-partner');
    expect(mockRunSlot).toHaveBeenCalledTimes(2);
  });

  it('throws CliUserError when both org and partner probes fail', async () => {
    mockRunSlot.mockRejectedValueOnce(new Error('org failed'));
    mockRunSlot.mockRejectedValueOnce(new Error('partner failed'));
    await expect(
      fetchProviderForKey({
        profileStore: fakeProfileStore,
        tenantId: 'tenant-1',
        keyValue: 'key',
        allowProbe: true
      })
    ).rejects.toThrow(CliUserError);
  });
});
