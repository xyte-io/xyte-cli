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

  it('aborts an idempotent request on the caller signal without retrying', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException('The operation was aborted', 'AbortError'));
            return;
          }
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const transport = new HttpTransport({ timeoutMs: 1_000, retryAttempts: 2, retryBackoffMs: 1 });

    const request = transport.request({
      method: 'GET',
      url: 'https://example.test/v1/devices',
      idempotent: true,
      signal: controller.signal
    });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels retry backoff when the caller aborts', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network down'));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const transport = new HttpTransport({ retryAttempts: 2, retryBackoffMs: 1_000 });
    const startedAt = Date.now();

    const request = transport.request({
      method: 'GET',
      url: 'https://example.test/v1/devices',
      idempotent: true,
      signal: controller.signal
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBeLessThan(500);
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

  it('includes upstream detail in http error message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Either a valid command or friendly_name is required' }), {
        status: 422,
        statusText: 'Unprocessable Content',
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const transport = new HttpTransport({ retryAttempts: 0 });

    await expect(
      transport.request({
        method: 'POST',
        url: 'https://example.test/v1/devices/dev-1/commands',
        endpointKey: 'test.key'
      })
    ).rejects.toThrow('Either a valid command or friendly_name is required');
  });

  it('treats empty 204 json responses as successful no-body results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 204,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const transport = new HttpTransport({ retryAttempts: 0 });
    const response = await transport.request({
      method: 'POST',
      url: 'https://example.test/v1/edge/start',
      endpointKey: 'organization.edge.startClaim',
      idempotent: false
    });

    expect(response.status).toBe(204);
    expect(response.data).toBeUndefined();
  });
});
