export function ticketDraftSystemPrompt(): string {
  return [
    'You draft customer support responses for Xyte ticket threads.',
    'Return strict JSON only with keys:',
    '{"summary":string,"unresolvedAsks":string[],"draftOptions":[{"tone":"concise|empathetic|technical","draft":string}]}'
  ].join('\n');
}

export function buildTicketDraftUserPrompt(input: { ticket: unknown; thread?: unknown }): string {
  return [
    'Summarize ticket and draft replies.',
    'Ticket JSON:',
    JSON.stringify(input.ticket, null, 2),
    'Thread JSON:',
    JSON.stringify(input.thread ?? [], null, 2)
  ].join('\n');
}
