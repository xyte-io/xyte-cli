import type { LLMRunOptions, LLMService } from '../llm/provider';
import { buildHealthSummaryUserPrompt, healthSummarySystemPrompt } from '../llm/prompts/health-summary';
import type { HealthSummaryResult } from './types';

export interface HealthSummaryInput {
  llm: LLMService;
  tenantId?: string;
  provider?: LLMRunOptions['provider'];
  model?: string;
  devices?: unknown;
  incidents?: unknown;
  tickets?: unknown;
}

export async function runHealthSummary(input: HealthSummaryInput): Promise<HealthSummaryResult> {
  const result = await input.llm.run({
    tenantId: input.tenantId,
    provider: input.provider,
    model: input.model,
    system: healthSummarySystemPrompt(),
    user: buildHealthSummaryUserPrompt({
      devices: input.devices,
      incidents: input.incidents,
      tickets: input.tickets
    }),
    expectJson: true
  });

  const json = (result.json ?? {}) as Partial<HealthSummaryResult>;

  return {
    provider: result.provider,
    model: result.model,
    raw: result.text,
    overview: json.overview ?? 'Overview unavailable.',
    onlineOfflineTrend: json.onlineOfflineTrend ?? 'Trend unavailable.',
    topProblematicSpaces: Array.isArray(json.topProblematicSpaces) ? json.topProblematicSpaces.map(String) : [],
    topProblematicModels: Array.isArray(json.topProblematicModels) ? json.topProblematicModels.map(String) : [],
    anomalies: Array.isArray(json.anomalies) ? json.anomalies.map(String) : []
  };
}
