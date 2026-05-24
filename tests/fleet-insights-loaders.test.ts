import { describe, expect, it, vi } from 'vitest';

import { collectFleetSnapshot } from '../src/workflows/fleet-insights';
import type { NamespaceCall, XyteCallArgs } from '../src/types/client';
import { makeEndpointSpec, makeXyteClientMock } from './support/typed-mocks';

function makeOrgClient(overrides: {
  getDevices?: NamespaceCall;
  getSpaces?: NamespaceCall;
  getIncidents?: NamespaceCall;
  getTickets?: NamespaceCall;
}) {
  return makeXyteClientMock({
    listTenantEndpoints: vi.fn(async () => [makeEndpointSpec({ authScope: 'organization' })]),
    organization: {
      getDevices: overrides.getDevices ?? vi.fn(async () => ({ items: [] })),
      getSpaces: overrides.getSpaces ?? vi.fn(async () => ({ items: [] })),
      getIncidents: overrides.getIncidents ?? vi.fn(async () => ({ items: [] })),
      getTickets: overrides.getTickets ?? vi.fn(async () => ({ items: [] }))
    },
    partner: {
      getDevices: vi.fn(async () => ({ items: [] })),
      getDeviceInfo: vi.fn(async () => ({})),
      getCommands: vi.fn(async () => ({ commands: [] })),
      getTelemetries: vi.fn(async () => ({ telemetries: [] })),
      getStateHistory: vi.fn(async () => ({ history: [] })),
      getTickets: vi.fn(async () => ({ items: [] }))
    }
  });
}

describe('fetchAllPages — pagination and non-paginated fallback', () => {
  it('collects all items across multiple pages', async () => {
    // First call returns 100 items (a full page), second returns empty → stop paginating
    const page1Items = Array.from({ length: 100 }, (_, i) => ({ id: `d${i}` }));
    const getDevices = vi.fn(async (args?: XyteCallArgs) => {
      if (!args?.query || args.query.page === 1) return { items: page1Items };
      return { items: [] };
    });
    const client = makeOrgClient({ getDevices });

    const snapshot = await collectFleetSnapshot({ client, tenantId: 't1', providerScope: 'organization' });
    expect(snapshot.devices).toHaveLength(100);
    // fetchSingle fallback should NOT have been called (pagination succeeded)
    // getDevices is called with page 1 (returns 100 items) then page 2 (returns empty)
    expect(getDevices).toHaveBeenCalledTimes(2);
  });

  it('falls back to non-paginated request when paginated call returns empty', async () => {
    // The paginated call returns empty; the non-paginated fetchSingle call returns items
    const getDevices = vi.fn(async (args?: XyteCallArgs) => {
      if (args?.query) return { items: [] }; // paginated call — returns empty
      return { items: [{ id: 'fallback-device' }] }; // fetchSingle — returns items
    });
    const client = makeOrgClient({ getDevices });

    const snapshot = await collectFleetSnapshot({ client, tenantId: 't1', providerScope: 'organization' });
    expect(snapshot.devices).toHaveLength(1);
    expect((snapshot.devices[0] as Record<string, unknown>).id).toBe('fallback-device');
  });
});

describe('loadAllOrganizationIncidents — deduplication', () => {
  it('deduplicates incidents returned by both active and closed status pages', async () => {
    const sharedIncident = { id: 'inc-1', status: 'active', created_at: '2024-01-01T00:00:00.000Z' };
    // The incidents endpoint is called twice — once per status ('active', 'closed').
    // Return the same incident ID for both to simulate a duplicate across statuses.
    const getIncidents = vi.fn(async () => ({ items: [sharedIncident] }));
    const client = makeOrgClient({ getIncidents });

    const snapshot = await collectFleetSnapshot({ client, tenantId: 't1', providerScope: 'organization' });
    // The same incident ID should appear only once in the output
    const ids = snapshot.incidents.map((item) => (item as Record<string, unknown>).id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
    expect(ids).toContain('inc-1');
  });

  it('merges distinct incidents from active and closed statuses', async () => {
    const getIncidents = vi.fn(async (args?: XyteCallArgs) => {
      if (args?.query?.status === 'active') return { items: [{ id: 'inc-active', status: 'active' }] };
      if (args?.query?.status === 'closed') return { items: [{ id: 'inc-closed', status: 'closed' }] };
      return { items: [] };
    });
    const client = makeOrgClient({ getIncidents });

    const snapshot = await collectFleetSnapshot({ client, tenantId: 't1', providerScope: 'organization' });
    const ids = snapshot.incidents.map((item) => (item as Record<string, unknown>).id);
    expect(ids).toContain('inc-active');
    expect(ids).toContain('inc-closed');
    expect(ids).toHaveLength(2);
  });
});

describe('mapWithConcurrency — via partner enrichment', () => {
  it('enriches all sampled devices concurrently via partner scope', async () => {
    const deviceIds = ['d1', 'd2', 'd3'];
    const getDevices = vi.fn(async () => ({ items: deviceIds.map((id) => ({ id })) }));
    const getDeviceInfo = vi.fn(async (_args?: XyteCallArgs) => ({ device: { model: 'ModelX' } }));
    const getCommands = vi.fn(async () => ({ commands: [] }));
    const getTelemetries = vi.fn(async () => ({ telemetries: [] }));
    const getStateHistory = vi.fn(async () => ({ history: [] }));

    const client = makeXyteClientMock({
      listTenantEndpoints: vi.fn(async () => [makeEndpointSpec({ authScope: 'partner' })]),
      partner: {
        getDevices,
        getDeviceInfo,
        getCommands,
        getTelemetries,
        getStateHistory,
        getTickets: vi.fn(async () => ({ items: [] }))
      }
    });

    await collectFleetSnapshot({ client, tenantId: 't1', providerScope: 'partner' });

    // All 3 device IDs should have been enriched
    expect(getDeviceInfo).toHaveBeenCalledTimes(deviceIds.length);
    const calledWith = getDeviceInfo.mock.calls.map((call) => call[0]?.path?.device_id);
    expect(calledWith.sort()).toEqual(deviceIds.sort());
  });
});
