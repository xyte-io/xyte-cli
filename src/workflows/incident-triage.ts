import type { LLMRunOptions, LLMService } from '../llm/provider';
import { buildIncidentTriageUserPrompt, incidentTriageSystemPrompt } from '../llm/prompts/incident-triage';
import type { IncidentTriageResult } from './types';

export interface IncidentTriageInput {
  llm: LLMService;
  tenantId?: string;
  provider?: LLMRunOptions['provider'];
  model?: string;
  incident: unknown;
  deviceContext?: unknown;
  ticketContext?: unknown;
  spaceContext?: unknown;
}

export async function runIncidentTriage(input: IncidentTriageInput): Promise<IncidentTriageResult> {
  const result = await input.llm.run({
    tenantId: input.tenantId,
    provider: input.provider,
    model: input.model,
    system: incidentTriageSystemPrompt(),
    user: buildIncidentTriageUserPrompt({
      incident: input.incident,
      deviceContext: input.deviceContext,
      ticketContext: input.ticketContext,
      spaceContext: input.spaceContext
    }),
    expectJson: true
  });

  const json = (result.json ?? {}) as Partial<IncidentTriageResult>;

  return {
    provider: result.provider,
    model: result.model,
    raw: result.text,
    rootCauseHypothesis: json.rootCauseHypothesis ?? 'Insufficient evidence from available context.',
    confidence: typeof json.confidence === 'number' ? Math.max(0, Math.min(1, json.confidence)) : 0.25,
    recommendedNextActions: Array.isArray(json.recommendedNextActions) ? json.recommendedNextActions.map(String) : [],
    escalationHint: json.escalationHint ?? 'Escalate if incident persists after first mitigation attempt.'
  };
}
