import { describe, expect, it } from 'vitest';

import { runIncidentTriage } from '../src/workflows/incident-triage';
import { runTicketDraft } from '../src/workflows/ticket-draft';
import { runHealthSummary } from '../src/workflows/health-summary';
import { runCommandSuggestions } from '../src/workflows/command-suggestions';

const llmStub = {
  async run() {
    return {
      provider: 'openai',
      model: 'gpt-4.1-mini',
      text: '{"ok":true}',
      json: {
        rootCauseHypothesis: 'Network flap',
        confidence: 0.82,
        recommendedNextActions: ['Restart switch', 'Check cabling'],
        escalationHint: 'Escalate to NOC if repeated',
        summary: 'Ticket summary',
        unresolvedAsks: ['Need ETA'],
        draftOptions: [{ tone: 'concise', draft: 'We are investigating.' }],
        overview: 'Fleet mostly healthy',
        onlineOfflineTrend: 'Stable',
        topProblematicSpaces: ['HQ/RoomA'],
        topProblematicModels: ['Model-X'],
        anomalies: ['Spike at 13:00'],
        recommendations: [{ command: 'reboot', rationale: 'Clear transient state', risk: 'medium' }],
        safetyNote: 'Confirm before execution'
      }
    };
  }
} as any;

describe('workflows', () => {
  it('returns deterministic incident triage shape', async () => {
    const result = await runIncidentTriage({ llm: llmStub, incident: { id: 1 } });
    expect(result.rootCauseHypothesis).toBe('Network flap');
    expect(result.recommendedNextActions.length).toBe(2);
  });

  it('returns deterministic ticket draft shape', async () => {
    const result = await runTicketDraft({ llm: llmStub, ticket: { id: 1 } });
    expect(result.summary).toBe('Ticket summary');
    expect(result.draftOptions[0]?.draft).toContain('investigating');
  });

  it('returns deterministic health summary shape', async () => {
    const result = await runHealthSummary({ llm: llmStub, devices: [] });
    expect(result.overview).toBe('Fleet mostly healthy');
    expect(result.topProblematicSpaces[0]).toBe('HQ/RoomA');
  });

  it('returns deterministic command suggestions shape', async () => {
    const result = await runCommandSuggestions({ llm: llmStub, device: { id: 1 } });
    expect(result.recommendations[0]?.command).toBe('reboot');
    expect(result.safetyNote).toContain('Confirm');
  });
});
