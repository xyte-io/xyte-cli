import { toProblemDetails } from '../client/errors';
import type { XyteClient } from '../types/client';
import { errorMessage } from '../utils/error-format';
import {
  EdgeProbeAbortError,
  EdgeProbeRowError,
  pollEdgeStatus,
  type EdgePollOptions,
  type EdgePollResult
} from './edge-poll';

export type EdgePingDisposition = 'succeeded' | 'failed' | 'rejected' | 'timeout';

export interface EdgePingResult {
  schemaVersion: 'xyte.edge.ping.v1';
  generatedAtUtc: string;
  tenantId: string;
  proxy_id: string;
  device_ip: string;
  disposition: EdgePingDisposition;
  attempts: number;
  elapsedMs: number;
  lastState?: string;
  detail?: string;
  response?: unknown;
}

export interface RunEdgePingArgs {
  client: XyteClient;
  tenantId: string;
  proxy_id: string;
  device_ip: string;
  pollOptions?: EdgePollOptions;
  sleeper?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function runEdgePing(args: RunEdgePingArgs): Promise<EdgePingResult> {
  const startedAt = (args.now ?? Date.now)();
  const base = {
    schemaVersion: 'xyte.edge.ping.v1' as const,
    tenantId: args.tenantId,
    proxy_id: args.proxy_id,
    device_ip: args.device_ip
  };

  try {
    await args.client.callWithMeta('organization.edge.startPing', {
      tenantId: args.tenantId,
      body: { proxy_id: args.proxy_id, device_ip: args.device_ip }
    });
  } catch (error) {
    const problem = toProblemDetails(error);
    if (problem.status === 401) {
      throw new EdgeProbeAbortError('Authorization failed; aborting run.', {
        status: problem.status,
        detail: problem.detail
      });
    }
    return {
      ...base,
      generatedAtUtc: new Date().toISOString(),
      disposition: 'rejected',
      attempts: 0,
      elapsedMs: (args.now ?? Date.now)() - startedAt,
      detail: problem.detail || errorMessage(error)
    };
  }

  let poll: EdgePollResult;
  try {
    poll = await pollEdgeStatus({
      client: args.client,
      tenantId: args.tenantId,
      statusEndpointKey: 'organization.edge.getPingStatus',
      statusResponseFields: ['status', 'result'],
      query: { proxy_id: args.proxy_id, device_ip: args.device_ip },
      options: args.pollOptions,
      sleeper: args.sleeper,
      now: args.now
    });
  } catch (error) {
    if (error instanceof EdgeProbeAbortError) throw error;
    if (error instanceof EdgeProbeRowError) {
      return {
        ...base,
        generatedAtUtc: new Date().toISOString(),
        disposition: 'failed',
        attempts: 0,
        elapsedMs: (args.now ?? Date.now)() - startedAt,
        detail: error.problem.detail
      };
    }
    throw error;
  }

  const disposition: EdgePingDisposition =
    poll.outcome === 'success' ? 'succeeded' : poll.outcome === 'failed' ? 'failed' : 'timeout';
  return {
    ...base,
    generatedAtUtc: new Date().toISOString(),
    disposition,
    attempts: poll.attempts,
    elapsedMs: poll.elapsedMs,
    lastState: poll.lastState,
    response: poll.lastPayload
  };
}
