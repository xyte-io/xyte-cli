import { describe, expect, it } from 'vitest';

import { toProblemDetails } from '../src/contracts/problem';
import { XyteHttpError } from '../src/http/errors';

describe('problem details redaction', () => {
  it('redacts sensitive detail and upstream values for http errors', () => {
    const error = new XyteHttpError({
      message: '401 unauthorized: token=abc123',
      status: 401,
      statusText: 'Unauthorized',
      details: {
        authorization: 'Bearer value-123',
        metadata: {
          api_key: 'super-secret',
          safe: 'ok'
        }
      }
    });

    const problem = toProblemDetails(error, '/call/organization.devices.getDevices');
    const upstream = problem.upstream as Record<string, any>;

    expect(problem.detail).toContain('token=[REDACTED]');
    expect(problem.detail).not.toContain('abc123');
    expect(upstream.authorization).toBe('[REDACTED]');
    expect(upstream.metadata.api_key).toBe('[REDACTED]');
    expect(upstream.metadata.safe).toBe('ok');
  });

  it('redacts unhandled string errors', () => {
    const problem = toProblemDetails('password=my-password');

    expect(problem.detail).toContain('password=[REDACTED]');
    expect(problem.detail).not.toContain('my-password');
  });
});
