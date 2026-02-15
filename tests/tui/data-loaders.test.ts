import { describe, expect, it } from 'vitest';

import { loadIncidentsData, loadSpaceDrilldownData, loadSpacesData } from '../../src/tui/data-loaders';

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
});
