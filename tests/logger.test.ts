import { describe, expect, it } from 'vitest';

import { getLogger } from '../src/observability/logger';

describe('getLogger', () => {
  it('returns a pino logger instance', () => {
    const logger = getLogger();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('returns the same singleton instance on repeated calls', () => {
    const a = getLogger();
    const b = getLogger();
    expect(a).toBe(b);
  });
});
