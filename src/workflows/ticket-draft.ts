import type { LLMRunOptions, LLMService } from '../llm/provider';
import { buildTicketDraftUserPrompt, ticketDraftSystemPrompt } from '../llm/prompts/ticket-draft';
import type { TicketDraftResult } from './types';

export interface TicketDraftInput {
  llm: LLMService;
  tenantId?: string;
  provider?: LLMRunOptions['provider'];
  model?: string;
  ticket: unknown;
  thread?: unknown;
}

export async function runTicketDraft(input: TicketDraftInput): Promise<TicketDraftResult> {
  const result = await input.llm.run({
    tenantId: input.tenantId,
    provider: input.provider,
    model: input.model,
    system: ticketDraftSystemPrompt(),
    user: buildTicketDraftUserPrompt({ ticket: input.ticket, thread: input.thread }),
    expectJson: true
  });

  const json = (result.json ?? {}) as Partial<TicketDraftResult>;

  return {
    provider: result.provider,
    model: result.model,
    raw: result.text,
    summary: json.summary ?? 'Summary unavailable.',
    unresolvedAsks: Array.isArray(json.unresolvedAsks) ? json.unresolvedAsks.map(String) : [],
    draftOptions: Array.isArray(json.draftOptions)
      ? json.draftOptions
          .filter((option): option is { tone: 'concise' | 'empathetic' | 'technical'; draft: string } => {
            return !!option && typeof option === 'object' && typeof (option as any).draft === 'string';
          })
          .map((option) => ({
            tone: ['concise', 'empathetic', 'technical'].includes((option as any).tone)
              ? (option as any).tone
              : 'concise',
            draft: option.draft
          }))
      : []
  };
}
