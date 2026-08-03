import { describe, expect, it, vi } from 'vitest';

import type { XyteClient } from '../src/types/client';
import { extractSentCommandId, MAX_COMMAND_POLL_DELAY_MS, pollCommandStatus } from '../src/workflows/command-poll';

function makeClient(responses: unknown[]): { client: XyteClient; callWithMeta: ReturnType<typeof vi.fn> } {
  const callWithMeta = vi.fn(async () => ({
    status: 200,
    headers: {},
    data: responses.shift(),
    durationMs: 1,
    retryCount: 0,
    attempts: 1
  }));
  return {
    client: {
      callWithMeta
    } as unknown as XyteClient,
    callWithMeta
  };
}

describe('command polling', () => {
  it('extracts a concrete id from each documented send response shape', () => {
    expect(extractSentCommandId({ id: 'cmd-1', status: 'pending' })).toBe('cmd-1');
    expect(extractSentCommandId([{ id: 'cmd-2', status: 'pending' }])).toBe('cmd-2');
  });

  it.each([
    { label: 'an empty array', payload: [] },
    { label: 'multiple command records', payload: [{ id: 'cmd-1' }, { id: 'cmd-2' }] },
    { label: 'a top-level record without an id', payload: { status: 'pending' } },
    { label: 'an array item without an id', payload: [{ status: 'pending' }] },
    { label: 'an empty id', payload: { id: '' } },
    { label: 'a whitespace-only id', payload: { id: '   ' } },
    { label: 'an id with surrounding whitespace', payload: [{ id: '  cmd-3  ' }] },
    { label: 'a non-string id', payload: { id: 33 } },
    { label: 'a null array item', payload: [null] },
    { label: 'a nested record', payload: { data: { id: 'cmd-1' } } },
    { label: 'a nested array item', payload: [{ data: { id: 'cmd-1' } }] },
    { label: 'a nested array', payload: [[{ id: 'cmd-1' }]] }
  ])('rejects $label as an ambiguous or invalid send response', ({ payload }) => {
    expect(extractSentCommandId(payload)).toBeUndefined();
  });

  it.each([
    {
      label: 'a done command',
      payload: { items: [{ id: 'cmd-1', status: 'done' }], has_next_page: false },
      outcome: 'done'
    },
    {
      label: 'an aborted command',
      payload: { items: [{ id: 'cmd-1', status: 'aborted' }], has_next_page: false },
      outcome: 'aborted'
    }
  ])('reads $label', async ({ payload, outcome }) => {
    const { client } = makeClient([payload]);

    const result = await pollCommandStatus({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      commandId: 'cmd-1',
      timeoutMs: 100
    });

    expect(result).toMatchObject({ outcome, attempts: 1, lastStatus: outcome });
  });

  it('matches the exact returned id and stops when that command is done', async () => {
    const { client, callWithMeta } = makeClient([
      {
        items: [
          { id: 'other', status: 'done' },
          { id: 'cmd-1', status: 'pending' }
        ],
        has_next_page: false
      },
      { items: [{ id: 'cmd-1', status: 'done' }], has_next_page: false }
    ]);
    let now = 0;

    const result = await pollCommandStatus({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      commandId: 'cmd-1',
      timeoutMs: 100,
      intervalMs: 10,
      now: () => now,
      sleeper: async (ms) => {
        now += ms;
      }
    });

    expect(result).toMatchObject({
      commandId: 'cmd-1',
      outcome: 'done',
      attempts: 2,
      lastStatus: 'done'
    });
    expect(callWithMeta).toHaveBeenCalledTimes(2);
    expect(callWithMeta).toHaveBeenCalledWith(
      'organization.commands.getCommands',
      expect.objectContaining({
        tenantId: 'acme',
        path: { device_id: 'dev-1' },
        query: { page: 1, per_page: 500 }
      })
    );
  });

  it('follows command-history pagination until it finds the exact id', async () => {
    const { client, callWithMeta } = makeClient([
      {
        items: [{ id: 'other', status: 'done' }],
        has_next_page: true
      },
      {
        items: [{ id: 'cmd-1', status: 'done' }],
        has_next_page: false
      }
    ]);

    const result = await pollCommandStatus({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      commandId: 'cmd-1',
      timeoutMs: 100
    });

    expect(result).toMatchObject({ outcome: 'done', attempts: 1, lastStatus: 'done' });
    expect(callWithMeta).toHaveBeenNthCalledWith(
      1,
      'organization.commands.getCommands',
      expect.objectContaining({
        tenantId: 'acme',
        path: { device_id: 'dev-1' },
        query: { page: 1, per_page: 500 }
      })
    );
    expect(callWithMeta).toHaveBeenNthCalledWith(
      2,
      'organization.commands.getCommands',
      expect.objectContaining({
        tenantId: 'acme',
        path: { device_id: 'dev-1' },
        query: { page: 2, per_page: 500 }
      })
    );
  });

  it('returns backend failed status without treating another command as the result', async () => {
    const { client } = makeClient([
      {
        items: [
          { id: 'other', status: 'done' },
          { id: 'cmd-1', status: 'failed', message: 'Rejected' }
        ],
        has_next_page: false
      }
    ]);

    const result = await pollCommandStatus({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      commandId: 'cmd-1',
      timeoutMs: 100
    });

    expect(result).toMatchObject({
      commandId: 'cmd-1',
      outcome: 'failed',
      attempts: 1,
      lastStatus: 'failed'
    });
  });

  it('waits only within the caller-provided timeout', async () => {
    const { client, callWithMeta } = makeClient([
      { items: [{ id: 'cmd-1', status: 'pending' }], has_next_page: false },
      { items: [{ id: 'cmd-1', status: 'in_progress' }], has_next_page: false },
      { items: [{ id: 'cmd-1', status: 'in_progress' }], has_next_page: false }
    ]);
    let now = 0;

    const result = await pollCommandStatus({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      commandId: 'cmd-1',
      timeoutMs: 10,
      intervalMs: 4,
      now: () => now,
      sleeper: async (ms) => {
        now += ms;
      }
    });

    expect(result).toMatchObject({
      outcome: 'timeout',
      attempts: 3,
      elapsedMs: 10,
      lastStatus: 'in_progress'
    });
    expect(callWithMeta).toHaveBeenCalledTimes(3);
  });

  it('times out on an unknown status without substituting another command', async () => {
    const { client } = makeClient([
      {
        items: [
          { id: 'other', status: 'done' },
          { id: 'cmd-1', status: 'not-a-real-status' }
        ],
        has_next_page: false
      }
    ]);
    let now = 0;

    const result = await pollCommandStatus({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      commandId: 'cmd-1',
      timeoutMs: 1,
      intervalMs: 1,
      now: () => now,
      sleeper: async (ms) => {
        now += ms;
      }
    });

    expect(result).toMatchObject({
      commandId: 'cmd-1',
      outcome: 'timeout',
      attempts: 1,
      command: { id: 'cmd-1', status: 'not-a-real-status' }
    });
    expect(result.lastStatus).toBeUndefined();
  });

  it('does not accept a terminal response that arrives after the polling deadline', async () => {
    let now = 0;
    const callWithMeta = vi.fn(async () => {
      now = 200;
      return {
        status: 200,
        headers: {},
        data: { items: [{ id: 'cmd-1', status: 'done' }], has_next_page: false },
        durationMs: 200,
        retryCount: 0,
        attempts: 1
      };
    });
    const client = { callWithMeta } as unknown as XyteClient;

    const result = await pollCommandStatus({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      commandId: 'cmd-1',
      timeoutMs: 100,
      now: () => now
    });

    expect(result).toMatchObject({ outcome: 'timeout', attempts: 1, elapsedMs: 200 });
    expect(result.lastStatus).toBeUndefined();
  });

  it('returns at the polling deadline when command history never responds', async () => {
    let requestSignal: AbortSignal | undefined;
    const callWithMeta = vi.fn(
      (_endpointKey: string, args?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          requestSignal = args?.signal;
          requestSignal?.addEventListener(
            'abort',
            () => reject(new DOMException('The operation was aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    const client = { callWithMeta } as unknown as XyteClient;
    const startedAt = Date.now();

    const result = await pollCommandStatus({
      client,
      tenantId: 'acme',
      deviceId: 'dev-1',
      commandId: 'cmd-1',
      timeoutMs: 20
    });

    expect(result.outcome).toBe('timeout');
    expect(callWithMeta).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it.each([
    { label: 'a missing items field', payload: { has_next_page: false } },
    { label: 'a non-array items field', payload: { items: {}, has_next_page: false } },
    { label: 'a missing page flag', payload: { items: [] } },
    { label: 'a non-boolean page flag', payload: { items: [], has_next_page: 'false' } },
    { label: 'a malformed history row', payload: { items: [null], has_next_page: false } }
  ])('rejects $label instead of silently timing out', async ({ payload }) => {
    const { client, callWithMeta } = makeClient([payload]);

    await expect(
      pollCommandStatus({
        client,
        tenantId: 'acme',
        deviceId: 'dev-1',
        commandId: 'cmd-1',
        timeoutMs: 100
      })
    ).rejects.toThrow('Invalid command history response');
    expect(callWithMeta).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'zero timeout', timeoutMs: 0, intervalMs: undefined },
    { label: 'timeout above the timer limit', timeoutMs: MAX_COMMAND_POLL_DELAY_MS + 1, intervalMs: undefined },
    { label: 'zero interval', timeoutMs: 100, intervalMs: 0 },
    { label: 'interval above the timer limit', timeoutMs: 100, intervalMs: MAX_COMMAND_POLL_DELAY_MS + 1 }
  ])('rejects $label before reading command history', async ({ timeoutMs, intervalMs }) => {
    const { client, callWithMeta } = makeClient([]);

    await expect(
      pollCommandStatus({
        client,
        tenantId: 'acme',
        deviceId: 'dev-1',
        commandId: 'cmd-1',
        timeoutMs,
        ...(intervalMs === undefined ? {} : { intervalMs })
      })
    ).rejects.toThrow(/positive safe integer no greater than 2147483647/);
    expect(callWithMeta).not.toHaveBeenCalled();
  });

  it('propagates command-history request failures', async () => {
    const callWithMeta = vi.fn(async () => {
      throw new Error('command history unavailable');
    });
    const client = { callWithMeta } as unknown as XyteClient;

    await expect(
      pollCommandStatus({
        client,
        tenantId: 'acme',
        deviceId: 'dev-1',
        commandId: 'cmd-1',
        timeoutMs: 100
      })
    ).rejects.toThrow('command history unavailable');
    expect(callWithMeta).toHaveBeenCalledTimes(1);
  });
});
