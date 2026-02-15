export function commandSuggestionsSystemPrompt(): string {
  return [
    'You suggest safe command candidates for managed devices.',
    'Return strict JSON only with keys:',
    '{"recommendations":[{"command":string,"rationale":string,"risk":"low|medium|high"}],"safetyNote":string}',
    'Never claim commands were executed.'
  ].join('\n');
}

export function buildCommandSuggestionsUserPrompt(input: {
  device: unknown;
  recentIncidents?: unknown;
  recentCommands?: unknown;
  goal?: string;
}): string {
  return [
    'Suggest command candidates. Output is advisory only.',
    `Goal: ${input.goal ?? 'stabilize device and verify health'}`,
    'Device JSON:',
    JSON.stringify(input.device, null, 2),
    'Recent incidents JSON:',
    JSON.stringify(input.recentIncidents ?? [], null, 2),
    'Recent commands JSON:',
    JSON.stringify(input.recentCommands ?? [], null, 2)
  ].join('\n');
}
