import type { LLMRunOptions, LLMService } from '../llm/provider';
import {
  buildCommandSuggestionsUserPrompt,
  commandSuggestionsSystemPrompt
} from '../llm/prompts/command-suggestions';
import type { CommandSuggestionResult } from './types';

export interface CommandSuggestionInput {
  llm: LLMService;
  tenantId?: string;
  provider?: LLMRunOptions['provider'];
  model?: string;
  device: unknown;
  recentIncidents?: unknown;
  recentCommands?: unknown;
  goal?: string;
}

export async function runCommandSuggestions(input: CommandSuggestionInput): Promise<CommandSuggestionResult> {
  const result = await input.llm.run({
    tenantId: input.tenantId,
    provider: input.provider,
    model: input.model,
    system: commandSuggestionsSystemPrompt(),
    user: buildCommandSuggestionsUserPrompt({
      device: input.device,
      recentIncidents: input.recentIncidents,
      recentCommands: input.recentCommands,
      goal: input.goal
    }),
    expectJson: true
  });

  const json = (result.json ?? {}) as Partial<CommandSuggestionResult>;
  const recommendations = Array.isArray((json as any).recommendations)
    ? (json as any).recommendations
        .filter((item: any) => item && typeof item.command === 'string' && typeof item.rationale === 'string')
        .map((item: any) => ({
          command: String(item.command),
          rationale: String(item.rationale),
          risk: ['low', 'medium', 'high'].includes(item.risk) ? item.risk : 'medium'
        }))
    : [];

  return {
    provider: result.provider,
    model: result.model,
    raw: result.text,
    recommendations,
    safetyNote:
      json.safetyNote ??
      'Suggestions are advisory only. Execute mutations only through explicit user-confirmed SDK/CLI paths.'
  };
}
