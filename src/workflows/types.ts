import type { LLMProvider } from '../llm/provider';

export interface WorkflowMeta {
  provider: LLMProvider;
  model: string;
  raw: string;
}

export interface IncidentTriageResult extends WorkflowMeta {
  rootCauseHypothesis: string;
  confidence: number;
  recommendedNextActions: string[];
  escalationHint: string;
}

export interface TicketDraftOption {
  tone: 'concise' | 'empathetic' | 'technical';
  draft: string;
}

export interface TicketDraftResult extends WorkflowMeta {
  summary: string;
  unresolvedAsks: string[];
  draftOptions: TicketDraftOption[];
}

export interface HealthSummaryResult extends WorkflowMeta {
  overview: string;
  onlineOfflineTrend: string;
  topProblematicSpaces: string[];
  topProblematicModels: string[];
  anomalies: string[];
}

export interface CommandSuggestionResult extends WorkflowMeta {
  recommendations: Array<{
    command: string;
    rationale: string;
    risk: 'low' | 'medium' | 'high';
  }>;
  safetyNote: string;
}
