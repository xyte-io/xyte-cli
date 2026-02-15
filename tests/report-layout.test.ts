import { describe, expect, it } from 'vitest';

import { buildDeepDive, formatDeepDiveMarkdown, formatUtcForReport, getWindowFocus } from '../src/workflows/fleet-insights';

describe('report layout helpers', () => {
  it('formats UTC timestamps into compact readable form', () => {
    expect(formatUtcForReport('2026-02-07T03:37:12Z')).toBe('2026-02-07 03:37 UTC');
    expect(formatUtcForReport('2026-02-07T03:37:12')).toBe('2026-02-07 03:37 UTC');
    expect(formatUtcForReport('2026-02-07T03:37:12+02:00')).toBe('2026-02-07 01:37 UTC');
    expect(formatUtcForReport('2026-02-08T07:28:31.761652+00:00')).toBe('2026-02-08 07:28 UTC');
    expect(formatUtcForReport('2026-02-08 07:28:31.761652+0000')).toBe('2026-02-08 07:28 UTC');
    expect(formatUtcForReport('2026-02-07')).toBe('2026-02-07 00:00 UTC');
  });

  it('keeps invalid timestamps as-is for safety', () => {
    expect(formatUtcForReport('not-a-date')).toBe('not-a-date');
  });

  it('maps window focus by horizon', () => {
    expect(getWindowFocus(24).label).toContain('Immediate');
    expect(getWindowFocus(72).label).toContain('Short-term');
    expect(getWindowFocus(168).label).toContain('Weekly');
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
});
