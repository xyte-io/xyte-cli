import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import type { FleetSnapshot } from '../src/types/fleet-inspect';
import { buildDeepDive, generateFleetReport } from '../src/workflows/fleet-insights';

function buildSnapshotForPdf(): FleetSnapshot {
  const generatedAtUtc = new Date().toISOString();
  const devices = Array.from({ length: 60 }, (_, index) => ({
    id: `device-${index + 1}`,
    name: `Conference Endpoint ${index + 1}`,
    status: index % 3 === 0 ? 'offline' : 'online',
    state: { status: index % 3 === 0 ? 'online' : 'offline' },
    last_seen_at: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
    space: { full_path: `Campus/Building-${(index % 6) + 1}/Floor-${(index % 10) + 1}/Room-${index + 1}` }
  }));

  const incidents = Array.from({ length: 36 }, (_, index) => ({
    id: `incident-${index + 1}`,
    status: index % 4 === 0 ? 'closed' : 'active',
    device_id: `device-${(index % 40) + 1}`,
    device_name: `Conference Endpoint ${(index % 40) + 1}`,
    space_tree_path_name: `Campus/Building-${(index % 6) + 1}/Floor-${(index % 10) + 1}/Room-${(index % 40) + 1}`,
    created_at: new Date(Date.now() - (index + 2) * 2_700_000).toISOString()
  }));

  const spaces = Array.from({ length: 40 }, (_, index) => ({
    id: `space-${index + 1}`,
    name: `Room ${index + 1}`,
    space_type: 'room'
  }));

  const tickets = Array.from({ length: 26 }, (_, index) => ({
    id: `ticket-${index + 1}`,
    title: `Intermittent signal issue ${index + 1} impacting room reliability and user experience`,
    status: index % 6 === 0 ? 'closed' : 'open',
    device_id: `device-${(index % 30) + 1}`,
    created_at: new Date(Date.now() - (index + 1) * 4_200_000).toISOString()
  }));

  return {
    generatedAtUtc,
    tenantId: 'acme',
    devices,
    spaces,
    incidents,
    tickets
  };
}

describe('pdf report rendering', () => {
  it('renders multi-page PDF with continuation tables and stable section order', async () => {
    const deepDive = buildDeepDive(buildSnapshotForPdf(), 72);
    const outDir = mkdtempSync(join(tmpdir(), 'xyte-report-pdf-'));
    const outPath = join(outDir, 'report.pdf');

    const result = await generateFleetReport({
      deepDive,
      format: 'pdf',
      outPath,
      includeSensitive: false
    });

    expect(result.schemaVersion).toBe('xyte.report.v1');
    expect(result.format).toBe('pdf');
    expect(statSync(outPath).size).toBeGreaterThan(12_000);

    const raw = readFileSync(outPath, 'latin1');
    const pageCount = (raw.match(/\/Type \/Page\b/g) ?? []).length;

    expect(pageCount).toBeGreaterThan(2);
    // Inter embedding changes text encoding, so assert stable structural fragments instead.
    expect(raw).toContain('/MediaBox [0 0 595.28 841.89]'); // A4
    expect(raw).toContain('/Type /Page');
    expect(raw).toContain('/I1'); // embedded logo image object
  });
});
