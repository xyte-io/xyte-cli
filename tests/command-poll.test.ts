import { describe, expect, it, vi } from 'vitest';

import type { XyteClient } from '../src/types/client';
import { extractSentCommandId, pollCommandStatus } from '../src/workflows/command-poll';

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
  it('extracts only a concrete id from the send response', () => {
    expect(extractSentCommandId({ id: 'cmd-1', status: 'pending' })).toBe('cmd-1');
    expect(extractSentCommandId([{ id: 'cmd-2' }])).toBe('cmd-2');
    expect(extractSentCommandId([{ id: 'cmd-1' }, { id: 'cmd-2' }])).toBeUndefined();
    expect(extractSentCommandId({ status: 'pending' })).toBeUndefined();
  });

  it('matches the exact returned id and stops when that command is done', async () => {
    const { client, callWithMeta } = makeClient([
      {
        items: [
          { id: 'other', status: 'done' },
          { id: 'cmd-1', status: 'pending' }
        ]
      },
      { items: [{ id: 'cmd-1', status: 'done' }] }
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
    expect(callWithMeta).toHaveBeenCalledWith('organization.commands.getCommands', {
      tenantId: 'acme',
      path: { device_id: 'dev-1' },
      query: { page: 1, per_page: 500 }
    });
  });

  it('returns backend failed status without treating another command as the result', async () => {
    const { client } = makeClient([
      {
        items: [
          { id: 'other', status: 'done' },
          { id: 'cmd-1', status: 'failed', message: 'Rejected' }
        ]
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
      { items: [{ id: 'cmd-1', status: 'pending' }] },
      { items: [{ id: 'cmd-1', status: 'in_progress' }] },
      { items: [{ id: 'cmd-1', status: 'in_progress' }] }
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
});
