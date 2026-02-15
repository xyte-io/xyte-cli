export function incidentTriageSystemPrompt(): string {
  return [
    'You are an operations assistant for Xyte-managed device fleets.',
    'Return strict JSON only with keys:',
    '{"rootCauseHypothesis":string,"confidence":number,"recommendedNextActions":string[],"escalationHint":string}',
    'confidence must be 0..1.'
  ].join('\n');
}

export function buildIncidentTriageUserPrompt(input: {
  incident: unknown;
  deviceContext?: unknown;
  ticketContext?: unknown;
  spaceContext?: unknown;
}): string {
  return [
    'Triaging incident with available context.',
    'Incident JSON:',
    JSON.stringify(input.incident, null, 2),
    'Device context JSON:',
    JSON.stringify(input.deviceContext ?? {}, null, 2),
    'Ticket context JSON:',
    JSON.stringify(input.ticketContext ?? {}, null, 2),
    'Space context JSON:',
    JSON.stringify(input.spaceContext ?? {}, null, 2)
  ].join('\n');
}
