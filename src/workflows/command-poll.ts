import type { XyteClient } from '../types/client';
import { isRecord } from '../utils/json';

export type CommandStatus = 'scheduled' | 'pending' | 'in_progress' | 'done' | 'failed' | 'aborted';
export type CommandPollOutcome = Extract<CommandStatus, 'done' | 'failed' | 'aborted'> | 'timeout';

export interface CommandPollResult {
  commandId: string;
  outcome: CommandPollOutcome;
  attempts: number;
  elapsedMs: number;
  lastStatus?: CommandStatus;
  command?: Record<string, unknown>;
}

export const DEFAULT_COMMAND_POLL_INTERVAL_MS = 5_000;

const COMMAND_STATUSES = new Set<CommandStatus>(['scheduled', 'pending', 'in_progress', 'done', 'failed', 'aborted']);
const TERMINAL_COMMAND_STATUSES = new Set<CommandStatus>(['done', 'failed', 'aborted']);

function normalizeStatus(value: unknown): CommandStatus | undefined {
  if (typeof value !== 'string') return undefined;
  const status = value.trim().toLowerCase() as CommandStatus;
  return COMMAND_STATUSES.has(status) ? status : undefined;
}

function commandRows(payload: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.items)
      ? payload.items
      : isRecord(payload) && Array.isArray(payload.data)
        ? payload.data
        : [];
  return rows.filter(isRecord);
}

export function extractSentCommandId(payload: unknown): string | undefined {
  const row = isRecord(payload) ? payload : Array.isArray(payload) && payload.length === 1 ? payload[0] : undefined;
  if (!isRecord(row) || typeof row.id !== 'string' || !row.id.trim()) {
    return undefined;
  }
  return row.id.trim();
}

export async function pollCommandStatus(args: {
  client: XyteClient;
  tenantId: string;
  deviceId: string;
  commandId: string;
  timeoutMs: number;
  intervalMs?: number;
  sleeper?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<CommandPollResult> {
  const now = args.now ?? (() => Date.now());
  const sleeper = args.sleeper ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = args.intervalMs ?? DEFAULT_COMMAND_POLL_INTERVAL_MS;
  const startedAt = now();
  let attempts = 0;
  let lastStatus: CommandStatus | undefined;
  let lastCommand: Record<string, unknown> | undefined;

  while (now() - startedAt < args.timeoutMs) {
    attempts += 1;
    const response = await args.client.callWithMeta('organization.commands.getCommands', {
      tenantId: args.tenantId,
      path: { device_id: args.deviceId },
      query: { page: 1, per_page: 500 }
    });
    const command = commandRows(response.data).find((row) => row.id === args.commandId);
    if (command) {
      lastCommand = command;
      lastStatus = normalizeStatus(command.status);
      if (lastStatus && TERMINAL_COMMAND_STATUSES.has(lastStatus)) {
        return {
          commandId: args.commandId,
          outcome: lastStatus as Extract<CommandStatus, 'done' | 'failed' | 'aborted'>,
          attempts,
          elapsedMs: now() - startedAt,
          lastStatus,
          command
        };
      }
    }

    const remainingMs = args.timeoutMs - (now() - startedAt);
    if (remainingMs <= 0) break;
    await sleeper(Math.min(intervalMs, remainingMs));
  }

  return {
    commandId: args.commandId,
    outcome: 'timeout',
    attempts,
    elapsedMs: now() - startedAt,
    ...(lastStatus ? { lastStatus } : {}),
    ...(lastCommand ? { command: lastCommand } : {})
  };
}
