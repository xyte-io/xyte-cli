import { describe, expect, it } from 'vitest';

import { withSpan } from '../src/observability/tracing';

describe('withSpan', () => {
  it('returns the result of the operation', async () => {
    const result = await withSpan('test-span', {}, async () => 42);
    expect(result).toBe(42);
  });

  it('propagates errors from the operation', async () => {
    await expect(
      withSpan('fail-span', {}, async () => {
        throw new Error('test error');
      })
    ).rejects.toThrow('test error');
  });

  it('passes span to the operation callback', async () => {
    await withSpan('span-arg', { key: 'value' }, async (span) => {
      expect(span).toBeDefined();
      expect(typeof span.end).toBe('function');
    });
  });
});
