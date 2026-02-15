import { describe, expect, it } from 'vitest';

import { formatIncidentTriageText, normalizeIncidents } from '../../src/tui/screens/incidents';
import { sceneFromIncidentsState } from '../../src/tui/scene';

describe('incidents screen helpers', () => {
  it('normalizes malformed incident payload items safely', () => {
    expect(normalizeIncidents(undefined)).toEqual([]);
    expect(normalizeIncidents([null, undefined, 'oops', { id: 'inc-1' }])).toEqual([{ value: 'oops' }, { id: 'inc-1' }]);
  });

  it('formats triage text with fallbacks when response is incomplete', () => {
    const text = formatIncidentTriageText({
      rootCauseHypothesis: undefined,
      confidence: Number.NaN,
      recommendedNextActions: undefined,
      escalationHint: undefined
    });

    expect(text).toContain('Root cause: unknown');
    expect(text).toContain('Confidence: 0.00');
    expect(text).toContain('Next actions:');
    expect(text).toContain('- none');
    expect(text).toContain('Escalation: none');
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
