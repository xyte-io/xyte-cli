import { describe, expect, it } from 'vitest';

import { formatReadinessText } from '../src/cli/format-readiness';
import type { ReadinessCheck } from '../src/config/readiness';

function makeReadiness(overrides: Partial<ReadinessCheck> = {}): ReadinessCheck {
  return {
    state: 'ready',
    tenantId: 'tenant-1',
    missingItems: [],
    recommendedActions: [],
    providers: [],
    connectionState: 'connected',
    connectivity: { state: 'connected', message: 'OK', retriable: false },
    ...overrides
  };
}

describe('formatReadinessText', () => {
  it('renders basic ready state', () => {
    const text = formatReadinessText(makeReadiness());
    expect(text).toContain('Readiness: ready');
    expect(text).toContain('Tenant: tenant-1');
    expect(text).toContain('Connectivity: connected (OK)');
    expect(text).toContain('Providers:');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('renders tenant as none when tenantId is undefined', () => {
    const text = formatReadinessText(makeReadiness({ tenantId: undefined }));
    expect(text).toContain('Tenant: none');
  });

  it('renders provider details', () => {
    const text = formatReadinessText(
      makeReadiness({
        providers: [
          {
            provider: 'xyte-org',
            slotCount: 2,
            activeSlotId: 'slot-1',
            activeSlotName: 'Production',
            hasActiveSecret: true
          }
        ]
      })
    );
    expect(text).toContain('- xyte-org: slots=2, active=slot-1 (Production), hasSecret=true');
  });

  it('renders provider with no active slot', () => {
    const text = formatReadinessText(
      makeReadiness({
        providers: [
          {
            provider: 'xyte-partner',
            slotCount: 0,
            hasActiveSecret: false
          }
        ]
      })
    );
    expect(text).toContain('- xyte-partner: slots=0, active=none (n/a), hasSecret=false');
  });

  it('renders missing items section when present', () => {
    const text = formatReadinessText(makeReadiness({ missingItems: ['No API key configured.'] }));
    expect(text).toContain('Missing items:');
    expect(text).toContain('- No API key configured.');
  });

  it('omits missing items section when empty', () => {
    const text = formatReadinessText(makeReadiness());
    expect(text).not.toContain('Missing items:');
  });

  it('renders recommended actions section when present', () => {
    const text = formatReadinessText(makeReadiness({ recommendedActions: ['Run setup wizard.'] }));
    expect(text).toContain('Recommended actions:');
    expect(text).toContain('- Run setup wizard.');
  });

  it('omits recommended actions section when empty', () => {
    const text = formatReadinessText(makeReadiness());
    expect(text).not.toContain('Recommended actions:');
  });
});
