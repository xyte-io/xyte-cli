import { describe, expect, it } from 'vitest';

import { buildDeepDive, formatDeepDiveMarkdown, formatUtcForReport, getWindowFocus } from '../src/workflows/fleet-insights';
import { buildDeepDiveOverviewPlan, buildDeepDiveReportSectionPlan, buildDeepDiveSummaryPlan } from '../src/workflows/report/pdf-render';
import { formatWindowLabel } from '../src/workflows/report/time-format';

describe('report layout helpers', () => {
  it('formats UTC timestamps into compact readable form', () => {
    expect(formatUtcForReport('2026-02-07T03:37:12Z')).toBe('Feb 07, 2026 03:37 UTC');
    expect(formatUtcForReport('2026-02-07T03:37:12')).toBe('Feb 07, 2026 03:37 UTC');
    expect(formatUtcForReport('2026-02-07T03:37:12+02:00')).toBe('Feb 07, 2026 01:37 UTC');
    expect(formatUtcForReport('2026-02-08T07:28:31.761652+00:00')).toBe('Feb 08, 2026 07:28 UTC');
    expect(formatUtcForReport('2026-02-08 07:28:31.761652+0000')).toBe('Feb 08, 2026 07:28 UTC');
    expect(formatUtcForReport('2026-02-07')).toBe('Feb 07, 2026 00:00 UTC');
  });

  it('keeps invalid timestamps as-is for safety', () => {
    expect(formatUtcForReport('not-a-date')).toBe('not-a-date');
  });

  it('maps window focus by horizon', () => {
    expect(getWindowFocus(24).label).toContain('Immediate');
    expect(getWindowFocus(72).label).toContain('Short-term');
    expect(getWindowFocus(168).label).toContain('Weekly');
    expect(formatWindowLabel(24)).toBe('Last 24 hours');
    expect(formatWindowLabel(1)).toBe('Last hour');
  });

  it('uses the requested window in deep-dive summary and markdown heading', () => {
    const result = buildDeepDive(
      {
        generatedAtUtc: new Date().toISOString(),
        tenantId: 'acme',
        devices: [{ id: 'd1', name: 'Device 1', status: 'offline', space: { full_path: 'Overview/A' } }],
        spaces: [{ id: 's1', name: 'Room A', space_type: 'room' }],
        incidents: [{ id: 'i1', device_name: 'Device 1', status: 'active', space_tree_path_name: 'Overview/A', created_at: new Date().toISOString() }],
        tickets: [{ id: 't1', title: 'Need help', status: 'open', created_at: new Date().toISOString(), device_id: 'd1' }]
      },
      72
    );

    expect(result.summary.some((line) => line.includes('72h churn'))).toBe(true);
    const markdown = formatDeepDiveMarkdown(result, false);
    expect(markdown).toContain('## 72-Hour Churn');
  });

  it('retains all active incidents in deep-dive aging list', () => {
    const incidents = Array.from({ length: 25 }, (_, index) => ({
      id: `i-${index}`,
      device_name: `Device ${index}`,
      status: 'active',
      space_tree_path_name: 'Overview/A',
      created_at: new Date(Date.now() - index * 60_000).toISOString()
    }));

    const result = buildDeepDive({
      generatedAtUtc: new Date().toISOString(),
      tenantId: 'acme',
      devices: [],
      spaces: [{ id: 's1', name: 'Room A', space_type: 'room' }],
      incidents,
      tickets: []
    });

    expect(result.activeIncidentAging.length).toBe(25);
  });

  it('omits incident and space summary lines for partner-scoped snapshots', () => {
    const result = buildDeepDive({
      generatedAtUtc: new Date().toISOString(),
      tenantId: 'xyte-partners',
      providerScope: 'partner',
      devices: [{ id: 'd1', name: 'Partner Device', status: 'online' }],
      spaces: [],
      incidents: [],
      tickets: [{ id: 't1', title: 'Need help', status: 'open', created_at: new Date().toISOString(), device_id: 'd1' }]
    });

    expect(result.summary.some((line) => line.startsWith('Incidents:'))).toBe(false);
    expect(result.summary.some((line) => line.includes('churn:'))).toBe(false);
    expect(result.summary.some((line) => line.startsWith('Tickets:'))).toBe(true);
  });

  it('renders markdown using only sections with available data', () => {
    const result = buildDeepDive({
      generatedAtUtc: new Date().toISOString(),
      tenantId: 'xyte-partners',
      providerScope: 'partner',
      devices: [{ id: 'd1', name: 'Partner Device', status: 'online' }],
      spaces: [],
      incidents: [],
      tickets: [{ id: 't1', title: 'Need help', status: 'open', created_at: new Date().toISOString(), device_id: 'd1' }]
    });

    const markdown = formatDeepDiveMarkdown(result, false);
    expect(markdown).not.toContain('## Top Offline Spaces');
    expect(markdown).not.toContain('## Top Devices by Incident Volume');
    expect(markdown).not.toContain('Hour Churn');
    expect(markdown).not.toContain('## Partner Highlights');
    expect(markdown).toContain('## Ticket Posture');
  });

  it('renders partner highlights block when partner summary lines are present', () => {
    const result = buildDeepDive({
      generatedAtUtc: new Date().toISOString(),
      tenantId: 'xyte-partners',
      providerScope: 'partner',
      devices: [{ id: 'd1', name: 'Partner Device', status: 'online' }],
      spaces: [],
      incidents: [],
      tickets: [{ id: 't1', title: 'Need help', status: 'open', created_at: new Date().toISOString(), device_id: 'd1' }],
      partnerEnrichment: {
        sampledDeviceCount: 1,
        totalDeviceCount: 1,
        endpointAvailability: {
          deviceInfo: { attempted: 1, succeeded: 1, failed: 0 },
          commands: { attempted: 1, succeeded: 1, failed: 0 },
          telemetries: { attempted: 1, succeeded: 1, failed: 0 },
          stateHistory: { attempted: 1, succeeded: 1, failed: 0 }
        },
        modelDistribution: { 'Model-X': 1 },
        firmwareDistribution: { '1.2.3': 1 },
        lastSeenRecency: { '<=1h': 1 },
        commandPosture: { sent: 1 },
        telemetryCoverage: { withTelemetries: 1, freshWithin24Hours: 1 },
        stateHistoryCoverage: { withHistory: 1, totalEntries: 3 }
      }
    });

    const markdown = formatDeepDiveMarkdown(result, false);
    expect(markdown).toContain('## Partner Highlights');
    expect(markdown).toContain('Partner model distribution:');
    expect(markdown).toContain('Partner telemetry coverage:');
  });

  it('builds PDF section plan from available deep-dive data only', () => {
    const partnerOnly = buildDeepDive({
      generatedAtUtc: new Date().toISOString(),
      tenantId: 'xyte-partners',
      providerScope: 'partner',
      devices: [{ id: 'd1', name: 'Partner Device', status: 'online' }],
      spaces: [],
      incidents: [],
      tickets: [{ id: 't1', title: 'Need help', status: 'open', created_at: new Date().toISOString(), device_id: 'd1' }]
    });

    const plan = buildDeepDiveReportSectionPlan(partnerOnly);
    expect(plan.includeOfflineSpaces).toBe(false);
    expect(plan.includeIncidentSections).toBe(false);
    expect(plan.includeTicketSection).toBe(true);
    expect(plan.includeTicketTable).toBe(true);
  });

  it('builds PDF summary plan with partner highlights sourced from partner-prefixed summary lines', () => {
    const partner = buildDeepDive({
      generatedAtUtc: new Date().toISOString(),
      tenantId: 'xyte-partners',
      providerScope: 'partner',
      devices: [{ id: 'd1', name: 'Partner Device', status: 'online' }],
      spaces: [],
      incidents: [],
      tickets: [{ id: 't1', title: 'Need help', status: 'open', created_at: new Date().toISOString(), device_id: 'd1' }],
      partnerEnrichment: {
        sampledDeviceCount: 1,
        totalDeviceCount: 1,
        endpointAvailability: {
          deviceInfo: { attempted: 1, succeeded: 1, failed: 0 },
          commands: { attempted: 1, succeeded: 1, failed: 0 },
          telemetries: { attempted: 1, succeeded: 1, failed: 0 },
          stateHistory: { attempted: 1, succeeded: 1, failed: 0 }
        },
        modelDistribution: { 'Model-X': 1 },
        firmwareDistribution: { '1.2.3': 1 },
        lastSeenRecency: { '<=1h': 1 },
        commandPosture: { sent: 1 },
        telemetryCoverage: { withTelemetries: 1, freshWithin24Hours: 1 },
        stateHistoryCoverage: { withHistory: 1, totalEntries: 3 }
      }
    });

    const plan = buildDeepDiveSummaryPlan(partner);
    expect(plan.partnerHighlights.length).toBeGreaterThan(0);
    expect(plan.partnerHighlights.every((line) => line.startsWith('Partner '))).toBe(true);
    expect(plan.executiveSummary.some((line) => line.startsWith('Devices:'))).toBe(true);
  });

  it('builds PDF overview plan with KPI details and spotlight cards', () => {
    const result = buildDeepDive({
      generatedAtUtc: new Date().toISOString(),
      tenantId: 'acme',
      devices: [
        { id: 'd1', name: 'Room One', status: 'offline', space: { full_path: 'Overview/HQ/Room 1' } },
        { id: 'd2', name: 'Room Two', status: 'offline', space: { full_path: 'Overview/HQ/Room 1' } },
        { id: 'd3', name: 'Room Three', status: 'online', space: { full_path: 'Overview/HQ/Room 2' } }
      ],
      spaces: [{ id: 's1', name: 'Room 1', space_type: 'room' }],
      incidents: [
        {
          id: 'i1',
          device_id: 'd1',
          device_name: 'Room One',
          status: 'active',
          space_tree_path_name: 'Overview/HQ/Room 1',
          created_at: new Date().toISOString()
        }
      ],
      tickets: [
        {
          id: 't1',
          title: 'Need help',
          status: 'open',
          created_at: new Date().toISOString(),
          device_id: 'd1'
        }
      ]
    });

    const plan = buildDeepDiveOverviewPlan(result);

    expect(plan.kpis).toHaveLength(6);
    expect(plan.kpis[1].label).toBe('Offline devices');
    expect(plan.kpis[1].detail).toContain('% of fleet');
    expect(plan.kpis[2].label).toBe('Active incidents');
    expect(plan.insights).toHaveLength(3);
    expect(plan.insights[0].title).toContain('Immediate');
    expect(plan.insights[1].eyebrow).toBe('Space hotspot');
    expect(plan.insights[2].body).toContain('overlap');
  });
});
