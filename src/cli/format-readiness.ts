import type { ReadinessCheck } from '../config/readiness';

export function formatReadinessText(readiness: ReadinessCheck): string {
  const lines: string[] = [];
  lines.push(`Readiness: ${readiness.state}`);
  lines.push(`Tenant: ${readiness.tenantId ?? 'none'}`);
  lines.push(`Connectivity: ${readiness.connectionState} (${readiness.connectivity.message})`);
  lines.push('');
  lines.push('Providers:');

  for (const provider of readiness.providers) {
    lines.push(
      `- ${provider.provider}: slots=${provider.slotCount}, active=${provider.activeSlotId ?? 'none'} (${provider.activeSlotName ?? 'n/a'}), hasSecret=${provider.hasActiveSecret}`
    );
  }

  if (readiness.missingItems.length) {
    lines.push('');
    lines.push('Missing items:');
    readiness.missingItems.forEach((item) => lines.push(`- ${item}`));
  }

  if (readiness.recommendedActions.length) {
    lines.push('');
    lines.push('Recommended actions:');
    readiness.recommendedActions.forEach((item) => lines.push(`- ${item}`));
  }

  return `${lines.join('\n')}\n`;
}
