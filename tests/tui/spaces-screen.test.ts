import { describe, expect, it } from 'vitest';

import { createStaleSafeSelectionLoader } from '../../src/tui/screens/spaces';

describe('spaces screen stale-safe loader', () => {
  it('ignores stale async responses', async () => {
    const applied: string[] = [];
    let resolveSlow: ((value: { id: string }) => void) | undefined;

    const loader = createStaleSafeSelectionLoader<{ id: string }, { id: string }>({
      load: async (input) => {
        if (input.id === 'slow') {
          return new Promise<{ id: string }>((resolve) => {
            resolveSlow = resolve;
          });
        }
        return { id: input.id };
      },
      apply: (result) => {
        applied.push(result.id);
      }
    });

    const slowPromise = loader({ id: 'slow' });
    const fastPromise = loader({ id: 'fast' });

    resolveSlow?.({ id: 'slow' });

    const [slowApplied, fastApplied] = await Promise.all([slowPromise, fastPromise]);

    expect(fastApplied).toBe(true);
    expect(slowApplied).toBe(false);
    expect(applied).toEqual(['fast']);
  });
});
