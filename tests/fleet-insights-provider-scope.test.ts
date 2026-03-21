import { describe, expect, it, vi } from 'vitest';

import { buildDeepDive, collectFleetSnapshot, type InspectProviderScope } from '../src/workflows/fleet-insights';
import type { XyteClient } from '../src/types/client';

type FixtureOptions = {
  hasOrganization: boolean;
  hasPartner: boolean;
  listTenantEndpointsError?: Error;
};

type Fixture = {
  client: XyteClient;
  listTenantEndpoints: ReturnType<typeof vi.fn>;
  organization: {
    getDevices: ReturnType<typeof vi.fn>;
    getSpaces: ReturnType<typeof vi.fn>;
    getIncidents: ReturnType<typeof vi.fn>;
    getTickets: ReturnType<typeof vi.fn>;
  };
  partner: {
    getDevices: ReturnType<typeof vi.fn>;
    getDeviceInfo: ReturnType<typeof vi.fn>;
    getCommands: ReturnType<typeof vi.fn>;
    getTelemetries: ReturnType<typeof vi.fn>;
    getStateHistory: ReturnType<typeof vi.fn>;
    getStateHistoryMultiDevices: ReturnType<typeof vi.fn>;
    getTickets: ReturnType<typeof vi.fn>;
  };
};

function makeFixture(options: FixtureOptions): Fixture {
  const organization = {
    getDevices: vi.fn(async () => ({ items: [{ id: 'od1', status: 'online' }] })),
    getSpaces: vi.fn(async () => ({ items: [{ id: 'os1', space_type: 'site' }] })),
    getIncidents: vi.fn(async () => ({ items: [{ id: 'oi1', status: 'active', created_at: '2024-01-01T00:00:00.000Z' }] })),
    getTickets: vi.fn(async () => ({ items: [{ id: 'ot1', status: 'open' }] }))
  };

  const partner = {
    getDevices: vi.fn(async () => ({ items: [{ id: 'pd1', status: 'offline' }] })),
    getDeviceInfo: vi.fn(async () => ({ device: { id: 'pd1', model: 'Model A', firmware_version: '1.0.0', last_seen_at: new Date().toISOString() } })),
    getCommands: vi.fn(async () => ({ commands: [{ id: 'c1', status: 'sent' }] })),
    getTelemetries: vi.fn(async () => ({ telemetries: [{ id: 'tm1', timestamp: new Date().toISOString() }] })),
    getStateHistory: vi.fn(async () => ({ history: [{ id: 'h1' }] })),
    getStateHistoryMultiDevices: vi.fn(async () => ({ histories: [] })),
    getTickets: vi.fn(async () => ({ items: [{ id: 'pt1', status: 'open' }] }))
  };

  const listTenantEndpoints = vi.fn(async () => {
    if (options.listTenantEndpointsError) {
      throw options.listTenantEndpointsError;
    }

    const endpoints: Array<{ authScope: 'organization' | 'partner' }> = [];
    if (options.hasOrganization) {
      endpoints.push({ authScope: 'organization' });
    }
    if (options.hasPartner) {
      endpoints.push({ authScope: 'partner' });
    }
    return endpoints as any;
  });

  return {
    client: {
      organization: organization as any,
      partner: partner as any,
      call: vi.fn(),
      callWithMeta: vi.fn(),
      describeEndpoint: vi.fn(),
      listEndpoints: vi.fn(),
      listTenantEndpoints
    },
    listTenantEndpoints,
    organization,
    partner
  };
}

function expectNoProviderDataCalls(fixture: Fixture): void {
  expect(fixture.organization.getDevices).not.toHaveBeenCalled();
  expect(fixture.organization.getSpaces).not.toHaveBeenCalled();
  expect(fixture.organization.getIncidents).not.toHaveBeenCalled();
  expect(fixture.organization.getTickets).not.toHaveBeenCalled();
  expect(fixture.partner.getDevices).not.toHaveBeenCalled();
  expect(fixture.partner.getDeviceInfo).not.toHaveBeenCalled();
  expect(fixture.partner.getCommands).not.toHaveBeenCalled();
  expect(fixture.partner.getTelemetries).not.toHaveBeenCalled();
  expect(fixture.partner.getStateHistory).not.toHaveBeenCalled();
  expect(fixture.partner.getStateHistoryMultiDevices).not.toHaveBeenCalled();
  expect(fixture.partner.getTickets).not.toHaveBeenCalled();
}

describe('fleet insights provider scope', () => {
  it('auto with neither provider configured follows legacy organization fallback and avoids partner endpoints', async () => {
    const fixture = makeFixture({ hasOrganization: false, hasPartner: false });

    const snapshot = await collectFleetSnapshot(fixture.client, 'acme', 'Acme', 'auto');

    expect(snapshot.providerScope).toBe('organization');
    expect(snapshot.devices.map((item) => (item as Record<string, unknown>).id)).toEqual(['od1']);
    expect(snapshot.spaces.map((item) => (item as Record<string, unknown>).id)).toEqual(['os1']);
    expect(snapshot.incidents.map((item) => (item as Record<string, unknown>).id)).toEqual(['oi1']);
    expect(snapshot.tickets.map((item) => (item as Record<string, unknown>).id)).toEqual(['ot1']);
    expect(fixture.organization.getDevices).toHaveBeenCalledTimes(1);
    expect(fixture.organization.getSpaces).toHaveBeenCalledTimes(1);
    expect(fixture.organization.getIncidents).toHaveBeenCalledTimes(2);
    expect(fixture.organization.getTickets).toHaveBeenCalledTimes(1);
    expect(fixture.partner.getDevices).not.toHaveBeenCalled();
    expect(fixture.partner.getTickets).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'explicit organization scope succeeds with organization-only provider',
      providerScope: 'organization' as InspectProviderScope,
      hasOrganization: true,
      hasPartner: false,
      expectedIds: { devices: ['od1'], spaces: ['os1'], incidents: ['oi1'], tickets: ['ot1'] },
      expectOrganizationCalls: true
    },
    {
      name: 'explicit partner scope succeeds with partner-only provider',
      providerScope: 'partner' as InspectProviderScope,
      hasOrganization: false,
      hasPartner: true,
      expectedIds: { devices: ['pd1'], spaces: [], incidents: [], tickets: ['pt1'] },
      expectOrganizationCalls: false
    }
  ])('$name', async ({ providerScope, hasOrganization, hasPartner, expectedIds, expectOrganizationCalls }) => {
    const fixture = makeFixture({ hasOrganization, hasPartner });

    const snapshot = await collectFleetSnapshot(fixture.client, 'acme', 'Acme', providerScope);

    expect(snapshot.providerScope).toBe(providerScope);
    expect(snapshot.devices.map((item) => (item as Record<string, unknown>).id)).toEqual(expectedIds.devices);
    expect(snapshot.spaces.map((item) => (item as Record<string, unknown>).id)).toEqual(expectedIds.spaces);
    expect(snapshot.incidents.map((item) => (item as Record<string, unknown>).id)).toEqual(expectedIds.incidents);
    expect(snapshot.tickets.map((item) => (item as Record<string, unknown>).id)).toEqual(expectedIds.tickets);

    if (expectOrganizationCalls) {
      expect(fixture.organization.getDevices).toHaveBeenCalledTimes(1);
      expect(fixture.organization.getSpaces).toHaveBeenCalledTimes(1);
      expect(fixture.organization.getIncidents).toHaveBeenCalledTimes(2);
      expect(fixture.organization.getTickets).toHaveBeenCalledTimes(1);
      expect(fixture.partner.getDevices).not.toHaveBeenCalled();
      expect(fixture.partner.getTickets).not.toHaveBeenCalled();
    } else {
      expect(fixture.organization.getDevices).not.toHaveBeenCalled();
      expect(fixture.organization.getSpaces).not.toHaveBeenCalled();
      expect(fixture.organization.getIncidents).not.toHaveBeenCalled();
      expect(fixture.organization.getTickets).not.toHaveBeenCalled();
      expect(fixture.partner.getDevices).toHaveBeenCalledTimes(1);
      expect(fixture.partner.getTickets).toHaveBeenCalledTimes(1);
      expect(fixture.partner.getDeviceInfo).toHaveBeenCalledTimes(1);
      expect(fixture.partner.getCommands).toHaveBeenCalledTimes(1);
      expect(fixture.partner.getTelemetries).toHaveBeenCalledTimes(1);
      expect(fixture.partner.getStateHistory).toHaveBeenCalledTimes(1);
      expect(fixture.partner.getStateHistoryMultiDevices).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      name: 'organization explicit scope is unavailable in partner-only setup',
      providerScope: 'organization' as InspectProviderScope,
      hasOrganization: false,
      hasPartner: true
    },
    {
      name: 'partner explicit scope is unavailable in organization-only setup',
      providerScope: 'partner' as InspectProviderScope,
      hasOrganization: true,
      hasPartner: false
    },
    {
      name: 'organization explicit scope is unavailable when neither provider is configured',
      providerScope: 'organization' as InspectProviderScope,
      hasOrganization: false,
      hasPartner: false
    },
    {
      name: 'partner explicit scope is unavailable when neither provider is configured',
      providerScope: 'partner' as InspectProviderScope,
      hasOrganization: false,
      hasPartner: false
    }
  ])('short-circuits before data calls when $name', async ({ providerScope, hasOrganization, hasPartner }) => {
    const fixture = makeFixture({ hasOrganization, hasPartner });

    await expect(collectFleetSnapshot(fixture.client, 'acme', 'Acme', providerScope)).rejects.toThrow(
      `Inspect provider scope "${providerScope}" is unavailable`
    );

    expect(fixture.listTenantEndpoints).toHaveBeenCalledWith('acme');
    expectNoProviderDataCalls(fixture);
  });

  it('propagates listTenantEndpoints failure and performs no provider data calls', async () => {
    const err = new Error('listTenantEndpoints failed');
    const fixture = makeFixture({ hasOrganization: true, hasPartner: true, listTenantEndpointsError: err });

    await expect(collectFleetSnapshot(fixture.client, 'acme', 'Acme', 'auto')).rejects.toThrow('listTenantEndpoints failed');

    expect(fixture.listTenantEndpoints).toHaveBeenCalledWith('acme');
    expectNoProviderDataCalls(fixture);
  });

  it('partner enrichment samples at most 25 devices and does not call multi-device history endpoint', async () => {
    const fixture = makeFixture({ hasOrganization: false, hasPartner: true });
    fixture.partner.getDevices.mockImplementation(async ({ query }: any = {}) => {
      const page = Number(query?.page ?? 1);
      if (page > 1) {
        return { items: [] };
      }
      return {
        items: Array.from({ length: 30 }, (_, index) => ({
          id: `pd${String(index + 1).padStart(2, '0')}`,
          status: index % 2 === 0 ? 'online' : 'offline',
          model: `Model-${(index % 3) + 1}`,
          firmware_version: `1.${index % 4}.0`,
          last_seen_at: new Date(Date.now() - index * 3_600_000).toISOString()
        }))
      };
    });

    const snapshot = await collectFleetSnapshot(fixture.client, 'acme', 'Acme', 'partner');
    const deepDive = buildDeepDive(snapshot, 24);

    expect(snapshot.partnerEnrichment?.sampledDeviceCount).toBe(25);
    expect(fixture.partner.getDeviceInfo).toHaveBeenCalledTimes(25);
    expect(fixture.partner.getCommands).toHaveBeenCalledTimes(25);
    expect(fixture.partner.getTelemetries).toHaveBeenCalledTimes(25);
    expect(fixture.partner.getStateHistory).toHaveBeenCalledTimes(25);
    expect(fixture.partner.getStateHistoryMultiDevices).not.toHaveBeenCalled();
    expect(deepDive.summary.some((line) => line.startsWith('Partner model distribution:'))).toBe(true);
    expect(deepDive.summary.some((line) => line.startsWith('Partner firmware distribution:'))).toBe(true);
    expect(deepDive.summary.some((line) => line.startsWith('Partner command posture:'))).toBe(true);
    expect(deepDive.summary.some((line) => line.startsWith('Partner telemetry coverage:'))).toBe(true);
    expect(deepDive.summary.some((line) => line.startsWith('Partner state history coverage:'))).toBe(true);
  });

  it('partner enrichment remains best-effort when optional endpoints fail', async () => {
    const fixture = makeFixture({ hasOrganization: false, hasPartner: true });
    fixture.partner.getCommands.mockRejectedValueOnce(new Error('commands unavailable'));
    fixture.partner.getTelemetries.mockRejectedValueOnce(new Error('telemetries unavailable'));

    const snapshot = await collectFleetSnapshot(fixture.client, 'acme', 'Acme', 'partner');
    const deepDive = buildDeepDive(snapshot, 24);

    expect(snapshot.devices.length).toBe(1);
    expect(snapshot.tickets.length).toBe(1);
    expect(deepDive.schemaVersion).toBe('xyte.inspect.deep-dive.v1');
    expect(deepDive.summary.some((line) => line.startsWith('Devices:'))).toBe(true);
    expect(deepDive.summary.some((line) => line.startsWith('Partner model distribution:'))).toBe(true);
  });

  it('caps partner enrichment call concurrency at 5 devices', async () => {
    const fixture = makeFixture({ hasOrganization: false, hasPartner: true });
    fixture.partner.getDevices.mockImplementation(async ({ query }: any = {}) => {
      const page = Number(query?.page ?? 1);
      if (page > 1) {
        return { items: [] };
      }
      return {
        items: Array.from({ length: 10 }, (_, index) => ({
          id: `pd${index + 1}`,
          status: 'online',
          last_seen_at: new Date().toISOString()
        }))
      };
    });

    let active = 0;
    let maxActive = 0;
    fixture.partner.getDeviceInfo.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { device: { model: 'Model A', firmware_version: '1.0.0', last_seen_at: new Date().toISOString() } };
    });

    await collectFleetSnapshot(fixture.client, 'acme', 'Acme', 'partner');

    expect(maxActive).toBeLessThanOrEqual(5);
  });

  it('applies a 3s timeout to stuck partner enrichment endpoint calls', async () => {
    const fixture = makeFixture({ hasOrganization: false, hasPartner: true });
    fixture.partner.getDeviceInfo.mockImplementation(
      () =>
        new Promise(() => {
          // Intentionally unresolved to assert timeout behavior.
        })
    );

    const started = Date.now();
    const snapshot = await collectFleetSnapshot(fixture.client, 'acme', 'Acme', 'partner');
    const elapsed = Date.now() - started;

    expect(snapshot.devices.length).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(2_500);
    expect(elapsed).toBeLessThan(10_000);
  });
});
