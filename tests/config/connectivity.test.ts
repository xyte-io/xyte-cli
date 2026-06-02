import { describe, expect, it } from 'vitest';

import { classifyConnectivityError } from '../../src/config/connectivity';
import { XyteAuthError, XyteHttpError } from '../../src/http/errors';

describe('classifyConnectivityError', () => {
  it('classifies XyteAuthError as auth_required', () => {
    const result = classifyConnectivityError(new XyteAuthError('Unauthorized'));
    expect(result.state).toBe('auth_required');
    expect(result.class).toBe('auth');
    expect(result.retriable).toBe(false);
  });

  it('classifies XyteAuthError with missing key message as missing_key', () => {
    const result = classifyConnectivityError(new XyteAuthError('Missing API key'));
    expect(result.state).toBe('missing_key');
    expect(result.class).toBe('missing_key');
    expect(result.retriable).toBe(false);
  });

  it('classifies 401 HTTP error as auth', () => {
    const result = classifyConnectivityError(
      new XyteHttpError({ message: 'Unauthorized', status: 401, statusText: 'Unauthorized' })
    );
    expect(result.state).toBe('auth_required');
    expect(result.class).toBe('auth');
    expect(result.retriable).toBe(false);
  });

  it('classifies 429 HTTP error as rate_limited', () => {
    const result = classifyConnectivityError(
      new XyteHttpError({ message: 'Too Many Requests', status: 429, statusText: 'Too Many Requests' })
    );
    expect(result.state).toBe('rate_limited');
    expect(result.class).toBe('rate_limit');
    expect(result.retriable).toBe(true);
  });

  it('classifies 500 HTTP error as network_error', () => {
    const result = classifyConnectivityError(
      new XyteHttpError({ message: 'Server Error', status: 500, statusText: 'Internal Server Error' })
    );
    expect(result.state).toBe('network_error');
    expect(result.class).toBe('network');
    expect(result.retriable).toBe(true);
  });

  it('classifies 408 HTTP error as timeout', () => {
    const result = classifyConnectivityError(
      new XyteHttpError({ message: 'Request Timeout', status: 408, statusText: 'Request Timeout' })
    );
    expect(result.state).toBe('timeout');
    expect(result.class).toBe('timeout');
    expect(result.retriable).toBe(true);
  });

  it('classifies AbortError DOMException as timeout', () => {
    const abort = new DOMException('The user aborted', 'AbortError');
    const result = classifyConnectivityError(abort);
    expect(result.state).toBe('timeout');
    expect(result.class).toBe('timeout');
    expect(result.retriable).toBe(true);
  });

  it('classifies TypeError as network_error', () => {
    const result = classifyConnectivityError(new TypeError('Failed to fetch'));
    expect(result.state).toBe('network_error');
    expect(result.class).toBe('network');
    expect(result.retriable).toBe(true);
  });

  it('classifies ECONNREFUSED as network_error', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const result = classifyConnectivityError(err);
    expect(result.state).toBe('network_error');
    expect(result.class).toBe('network');
    expect(result.retriable).toBe(true);
  });

  it('classifies ETIMEDOUT as timeout', () => {
    const err = Object.assign(new Error('connection ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const result = classifyConnectivityError(err);
    expect(result.state).toBe('timeout');
    expect(result.class).toBe('timeout');
    expect(result.retriable).toBe(true);
  });

  it('classifies unknown errors as unknown_error (retriable)', () => {
    const result = classifyConnectivityError(new Error('Something unexpected'));
    expect(result.state).toBe('unknown_error');
    expect(result.class).toBe('unknown');
    expect(result.retriable).toBe(true);
  });
});
