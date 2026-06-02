import { describe, expect, it } from 'vitest';

import { DeepDiveResultSchema } from '../../src/types/deep-dive';

function makeValidDeepDive() {
  return {
    schemaVersion: 'xyte.inspect.deep-dive.v1' as const,
    generatedAtUtc: '2024-01-01T00:00:00.000Z',
    tenantId: 'acme',
    windowHours: 24,
    summary: ['All systems nominal'],
    topOfflineSpaces: [],
    topIncidentDevices: [],
    activeIncidentAging: [],
    churnWindow: { incidents: 0, devices: 0, spaces: 0, bySpace: [], byDevice: [] },
    ticketPosture: { openTickets: 0, overlappingActiveIncidentDevices: 0, oldestOpenTickets: [] },
    dataQuality: { statusMismatches: [] }
  };
}

describe('DeepDiveResultSchema', () => {
  it('accepts a minimal valid deep dive', () => {
    const result = DeepDiveResultSchema.safeParse(makeValidDeepDive());
    expect(result.success).toBe(true);
  });

  it('accepts optional tenantName and overviewMetrics', () => {
    const input = {
      ...makeValidDeepDive(),
      tenantName: 'Acme Corp',
      overviewMetrics: {
        totalDevices: 100,
        offlineDevices: 5,
        offlinePct: 5,
        totalIncidents: 10,
        activeIncidents: 3,
        activeIncidentPct: 30,
        totalTickets: 7,
        openTickets: 2,
        statusMismatches: 1
      }
    };
    const result = DeepDiveResultSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('rejects wrong schemaVersion', () => {
    const input = { ...makeValidDeepDive(), schemaVersion: 'wrong.version' };
    const result = DeepDiveResultSchema.safeParse(input);
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const { summary: _, ...without } = makeValidDeepDive();
    const result = DeepDiveResultSchema.safeParse(without);
    expect(result.success).toBe(false);
  });

  it('accepts populated churnWindow entries', () => {
    const input = {
      ...makeValidDeepDive(),
      churnWindow: {
        incidents: 5,
        devices: 2,
        spaces: 1,
        bySpace: [{ space: 'Floor 1', incidents: 3 }],
        byDevice: [{ device: 'dev-1', incidents: 2 }]
      }
    };
    const result = DeepDiveResultSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('accepts populated topOfflineSpaces', () => {
    const input = {
      ...makeValidDeepDive(),
      topOfflineSpaces: [{ space: 'Lobby', offlineDevices: 3, shareOfOfflinePct: 60 }]
    };
    const result = DeepDiveResultSchema.safeParse(input);
    expect(result.success).toBe(true);
  });
});
