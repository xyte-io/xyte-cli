import { describe, expect, it } from 'vitest';

import { sceneFromIncidentsState } from '../../src/tui/scene';

function castIncidentRecords(items: unknown): Record<string, unknown>[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .filter((incident) => incident !== null && incident !== undefined)
    .map((incident) => (typeof incident === 'object' ? (incident as Record<string, unknown>) : { value: incident }));
}

describe('incidents screen helpers', () => {
  it('normalizes malformed incident payload items safely', () => {
    expect(castIncidentRecords(undefined)).toEqual([]);
    expect(castIncidentRecords([null, undefined, 'oops', { id: 'inc-1' }])).toEqual([
      { value: 'oops' },
      { id: 'inc-1' }
    ]);
  });

  it('renders incident detail safely for cyclic payloads', () => {
    const incident: Record<string, unknown> = { id: 'inc-1', severity: 'high', status: 'open' };
    incident.self = incident;

    const panels = sceneFromIncidentsState({
      selectedIndex: 0,
      severityFilter: '',
      incidents: [incident]
    });
    const detailPanel = panels.find((panel) => panel.id === 'incidents-detail');
    const lines = detailPanel?.text?.lines ?? [];

    expect(lines.join('\n')).toContain('[Circular]');
  });
});
