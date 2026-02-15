import { describe, expect, it } from 'vitest';

import { normalizeIncidents } from '../../src/tui/screens/incidents';
import { sceneFromIncidentsState } from '../../src/tui/scene';

describe('incidents screen helpers', () => {
  it('normalizes malformed incident payload items safely', () => {
    expect(normalizeIncidents(undefined)).toEqual([]);
    expect(normalizeIncidents([null, undefined, 'oops', { id: 'inc-1' }])).toEqual([{ value: 'oops' }, { id: 'inc-1' }]);
  });

  it('renders incident detail safely for cyclic payloads', () => {
    const incident: any = { id: 'inc-1', severity: 'high', status: 'open' };
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
