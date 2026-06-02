import { describe, expect, it } from 'vitest';

import { formatFleetInspectAscii } from '../src/workflows/fleet-insights-format';
import type { FleetInspectResult } from '../src/types/fleet-inspect';

function makeResult(overrides: Partial<FleetInspectResult> = {}): FleetInspectResult {
  return {
    schemaVersion: '1.0.0' as FleetInspectResult['schemaVersion'],
    generatedAtUtc: '2026-01-01T00:00:00Z',
    tenantId: 'tenant-123',
    totals: { devices: 100, spaces: 10, incidents: 50, tickets: 20 },
    status: {
      devices: { online: 80, offline: 20 },
      incidents: { active: 10, closed: 40 },
      tickets: { open: 5 },
      spaces: {}
    },
    highlights: {
      offlineDevices: 20,
      offlinePct: 20,
      activeIncidents: 10,
      activeIncidentPct: 20,
      openTickets: 5
    },
    ...overrides
  };
}

describe('formatFleetInspectAscii', () => {
  it('includes tenant ID in header', () => {
    const result = formatFleetInspectAscii(makeResult());
    expect(result).toContain('tenant-123');
  });

  it('includes device status bars', () => {
    const result = formatFleetInspectAscii(makeResult());
    expect(result).toContain('offline');
    expect(result).toContain('online');
  });

  it('includes incident section', () => {
    const result = formatFleetInspectAscii(makeResult());
    expect(result).toContain('INCIDENTS');
    expect(result).toContain('active');
    expect(result).toContain('closed');
  });

  it('includes ticket section', () => {
    const result = formatFleetInspectAscii(makeResult());
    expect(result).toContain('TICKETS');
  });

  it('includes highlights line', () => {
    const result = formatFleetInspectAscii(makeResult());
    expect(result).toContain('Highlights:');
    expect(result).toContain('offline=20%');
    expect(result).toContain('open_tickets=5');
  });

  it('handles zero totals gracefully', () => {
    const result = formatFleetInspectAscii(makeResult({ totals: { devices: 0, spaces: 0, incidents: 0, tickets: 0 } }));
    expect(result).toContain('DEVICES');
  });
});
