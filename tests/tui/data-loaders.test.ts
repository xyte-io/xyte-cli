import { describe, expect, it } from 'vitest';

import {
  loadCommandTemplates,
  loadDevicesData,
  loadIncidentsData,
  loadSpaceDrilldownData,
  loadSpacesData
} from '../../src/tui/data-loaders';

describe('tui data loaders', () => {
  it('loads spaces list from organization API', async () => {
    const client: any = {
      organization: {
        getSpaces: async () => ({ data: [{ id: 's1', name: 'HQ' }] })
      }
    };

    const spaces = await loadSpacesData(client, 'acme');
    expect(spaces.data).toEqual([{ id: 's1', name: 'HQ' }]);
    expect(spaces.connectionState).toBe('connected');
  });

  it('loads space drilldown using query result when available', async () => {
    const client: any = {
      organization: {
        getSpace: async () => ({ id: 's1', name: 'HQ' }),
        getDevices: async () => ({ data: [{ id: 'd1', space_id: 's1' }] })
      }
    };

    const result = await loadSpaceDrilldownData(client, 'acme', 's1', []);
    expect(result.data.spaceDetail).toEqual({ id: 's1', name: 'HQ' });
    expect(result.data.devicesInSpace.length).toBe(1);
    expect(result.data.paneStatus).toContain('Loaded');
    expect(result.connectionState).toBe('connected');
  });

  it('falls back to cached devices when query returns none', async () => {
    const client: any = {
      organization: {
        getSpace: async () => ({ id: 's1', name: 'HQ' }),
        getDevices: async () => ({ data: [] })
      }
    };

    const result = await loadSpaceDrilldownData(client, 'acme', 's1', [
      { id: 'd1', space_id: 's1' },
      { id: 'd2', space_id: 's2' }
    ]);

    expect(result.data.devicesInSpace.map((item: any) => item.id)).toEqual(['d1']);
    expect(result.data.paneStatus).toContain('fallback');
  });

  it('extracts incidents from known wrappers and normalizes primitive values', async () => {
    const client: any = {
      organization: {
        getIncidents: async () => ({
          response: {
            incidents: [{ id: 'inc-1' }, 'legacy-value']
          }
        })
      }
    };

    const incidents = await loadIncidentsData(client, 'acme');
    expect(incidents.connectionState).toBe('connected');
    expect(incidents.data).toEqual([{ id: 'inc-1' }, { value: 'legacy-value' }]);
  });

  it('queries active incidents with integer range and pagination', async () => {
    const calls: any[] = [];
    const client: any = {
      organization: {
        getIncidents: async (args: any) => {
          calls.push(args);
          const page = args?.query?.page ?? 1;
          if (page === 1) {
            return { items: [{ id: 'inc-1' }], has_next_page: true };
          }
          if (page === 2) {
            return { items: [{ id: 'inc-2' }], has_next_page: false };
          }
          return { items: [], has_next_page: false };
        }
      }
    };

    const incidents = await loadIncidentsData(client, 'acme');
    expect(incidents.connectionState).toBe('connected');
    expect(incidents.data.map((incident: any) => incident.id)).toEqual(['inc-1', 'inc-2']);
    expect(calls.length).toBe(2);
    expect(calls[0]?.tenantId).toBe('acme');
    expect(calls[0]?.query?.status).toBe('active');
    expect(calls[0]?.query?.from).toBe(0);
    expect(typeof calls[0]?.query?.to).toBe('number');
    expect(calls[0]?.query?.page).toBe(1);
    expect(calls[0]?.query?.per_page).toBe(100);
  });

  it('returns connection metadata for incident loader failures', async () => {
    const client: any = {
      organization: {
        getIncidents: async () => {
          throw new TypeError('network unavailable');
        }
      }
    };

    const incidents = await loadIncidentsData(client, 'acme');
    expect(incidents.connectionState).toBe('network_error');
    expect(incidents.error?.class).toBe('network');
    expect(incidents.retry.retried).toBe(true);
  });

  it('passes devices space_id query and preserves local fallback filtering', async () => {
    const client: any = {
      organization: {
        getDevices: async (args: any) => ({
          query: args.query,
          items: [
            { id: 'd1', space_id: 's1' },
            { id: 'd2', space_id: 's2' }
          ]
        })
      },
      partner: {
        getDevices: async () => []
      }
    };

    const devices = await loadDevicesData(client, 'acme', { query: { space_id: 's1' } });
    expect(devices.connectionState).toBe('connected');
    expect(devices.data.map((item) => item.id)).toEqual(['d1']);
  });

  it('passes structured spaces query fields', async () => {
    const calls: any[] = [];
    const client: any = {
      organization: {
        getSpaces: async (args: any) => {
          calls.push(args);
          return { items: [{ id: 's1' }] };
        }
      }
    };

    const spaces = await loadSpacesData(client, 'acme', {
      query: {
        name: 'HQ',
        parent_id: '100',
        space_type: 'office',
        path_includes: 'Floor 1'
      }
    });
    expect(spaces.connectionState).toBe('connected');
    expect(spaces.data).toEqual([{ id: 's1' }]);
    expect(calls[0].query).toEqual({
      name: 'HQ',
      parent_id: '100',
      space_type: 'office',
      path_includes: 'Floor 1'
    });
  });

  it('loads command templates from organization getCommands', async () => {
    const client: any = {
      organization: {
        getCommands: async () => ({
          items: [
            { command: 'reboot' },
            { friendly_name: 'power_cycle' }
          ]
        })
      }
    };

    const templates = await loadCommandTemplates(client, 'acme', 'dev-1');
    expect(templates.connectionState).toBe('connected');
    expect(templates.data).toEqual([
      { mode: 'command', value: 'reboot', label: 'command: reboot' },
      { mode: 'friendly_name', value: 'power_cycle', label: 'friendly_name: power_cycle' }
    ]);
  });
});
