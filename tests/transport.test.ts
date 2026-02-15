import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpTransport } from '../src/http/transport';
import { XyteHttpError } from '../src/http/errors';

describe('http transport', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('retries idempotent requests after transient failures', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );

    vi.stubGlobal('fetch', fetchMock);

    const transport = new HttpTransport({ retryAttempts: 1, retryBackoffMs: 1 });
    const response = await transport.request<{ ok: boolean }>({
      method: 'GET',
      url: 'https://example.test/v1/devices',
      idempotent: true
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.data.ok).toBe(true);
    expect(response.meta.attempts).toBe(2);
    expect(response.meta.retryCount).toBe(1);
    expect(response.meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('does not retry non-idempotent requests', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const transport = new HttpTransport({ retryAttempts: 2, retryBackoffMs: 1 });

    await expect(
      transport.request({
        method: 'POST',
        url: 'https://example.test/v1/devices',
        idempotent: false
      })
    ).rejects.toThrow('network down');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parses structured error responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: 'unauthorized' }), {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const transport = new HttpTransport({ retryAttempts: 0 });

    await expect(
      transport.request({ method: 'GET', url: 'https://example.test/v1/devices', endpointKey: 'test.key' })
    ).rejects.toMatchObject({
      status: 401,
      endpointKey: 'test.key'
    } satisfies Partial<XyteHttpError>);
  });
});
