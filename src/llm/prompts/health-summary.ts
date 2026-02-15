export function healthSummarySystemPrompt(): string {
  return [
    'You summarize fleet health for operations teams.',
    'Return strict JSON only with keys:',
    '{"overview":string,"onlineOfflineTrend":string,"topProblematicSpaces":string[],"topProblematicModels":string[],"anomalies":string[]}'
  ].join('\n');
}

export function buildHealthSummaryUserPrompt(input: { devices?: unknown; incidents?: unknown; tickets?: unknown }): string {
  return [
    'Summarize health using fleet snapshots.',
    'Devices JSON:',
    JSON.stringify(input.devices ?? [], null, 2),
    'Incidents JSON:',
    JSON.stringify(input.incidents ?? [], null, 2),
    'Tickets JSON:',
    JSON.stringify(input.tickets ?? [], null, 2)
  ].join('\n');
}
