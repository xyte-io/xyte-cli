import { describe, expect, it } from 'vitest';

import { classifyConnectivityError } from '../src/config/connectivity';
import { XyteAuthError, XyteHttpError } from '../src/http/errors';

describe('classifyConnectivityError', () => {
  it('classifies XyteAuthError as auth', () => {
    const result = classifyConnectivityError(new XyteAuthError('Forbidden'));
    expect(result.state).toBe('auth_required');
    expect(result.class).toBe('auth');
    expect(result.retriable).toBe(false);
  });

  it('classifies missing key auth error as missing_key', () => {
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
  });

  it('classifies 403 HTTP error as auth', () => {
    const result = classifyConnectivityError(
      new XyteHttpError({ message: 'Forbidden', status: 403, statusText: 'Forbidden' })
    );
    expect(result.class).toBe('auth');
  });

  it('classifies 429 HTTP error as rate_limit', () => {
    const result = classifyConnectivityError(
      new XyteHttpError({ message: 'Too Many', status: 429, statusText: 'Too Many Requests' })
    );
    expect(result.state).toBe('rate_limited');
    expect(result.class).toBe('rate_limit');
    expect(result.retriable).toBe(true);
  });

  it('classifies 500 HTTP error as network', () => {
    const result = classifyConnectivityError(
      new XyteHttpError({ message: 'Server Error', status: 500, statusText: 'Internal Server Error' })
    );
    expect(result.class).toBe('network');
    expect(result.retriable).toBe(true);
  });

  it('classifies TypeError as network_error', () => {
    const result = classifyConnectivityError(new TypeError('fetch failed'));
    expect(result.state).toBe('network_error');
    expect(result.class).toBe('network');
  });

  it('classifies ECONNREFUSED as network', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const result = classifyConnectivityError(err);
    expect(result.class).toBe('network');
  });

  it('classifies ETIMEDOUT as timeout', () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    const result = classifyConnectivityError(err);
    expect(result.class).toBe('timeout');
  });

  it('returns unknown for unrecognized errors', () => {
    const result = classifyConnectivityError(new Error('something unexpected'));
    expect(result.state).toBe('unknown_error');
    expect(result.class).toBe('unknown');
    expect(result.retriable).toBe(true);
  });
});
