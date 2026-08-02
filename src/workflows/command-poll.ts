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
export const MAX_COMMAND_POLL_DELAY_MS = 2_147_483_647;

const COMMAND_STATUSES = new Set<CommandStatus>(['scheduled', 'pending', 'in_progress', 'done', 'failed', 'aborted']);
const TERMINAL_COMMAND_STATUSES = new Set<CommandStatus>(['done', 'failed', 'aborted']);
const COMMAND_POLL_DEADLINE = Symbol('command-poll-deadline');

async function settleBeforeDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number
): Promise<T | typeof COMMAND_POLL_DEADLINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof COMMAND_POLL_DEADLINE>((resolve) => {
    timer = setTimeout(() => resolve(COMMAND_POLL_DEADLINE), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeStatus(value: unknown): CommandStatus | undefined {
  if (typeof value !== 'string') return undefined;
  return COMMAND_STATUSES.has(value as CommandStatus) ? (value as CommandStatus) : undefined;
}

function commandPage(payload: unknown): { rows: Record<string, unknown>[]; hasNextPage: boolean } {
  if (
    !isRecord(payload) ||
    !Array.isArray(payload.items) ||
    !payload.items.every(isRecord) ||
    typeof payload.has_next_page !== 'boolean'
  ) {
    throw new Error('Invalid command history response: expected items array and boolean has_next_page.');
  }
  return {
    rows: payload.items,
    hasNextPage: payload.has_next_page
  };
}

function validatePollDelay(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_COMMAND_POLL_DELAY_MS) {
    throw new Error(`${label} must be a positive safe integer no greater than ${MAX_COMMAND_POLL_DELAY_MS}.`);
  }
}

export function extractSentCommandId(payload: unknown): string | undefined {
  if (!isRecord(payload) || typeof payload.id !== 'string' || !payload.id || payload.id.trim() !== payload.id) {
    return undefined;
  }
  return payload.id;
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
  validatePollDelay(args.timeoutMs, 'timeoutMs');
  if (args.intervalMs !== undefined) validatePollDelay(args.intervalMs, 'intervalMs');
  const now = args.now ?? (() => Date.now());
  const sleeper = args.sleeper ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const intervalMs = args.intervalMs ?? DEFAULT_COMMAND_POLL_INTERVAL_MS;
  const startedAt = now();
  let attempts = 0;
  let lastStatus: CommandStatus | undefined;
  let lastCommand: Record<string, unknown> | undefined;

  while (now() - startedAt < args.timeoutMs) {
    attempts += 1;
    let page = 1;
    let command: Record<string, unknown> | undefined;
    let deadlineReached = false;
    while (true) {
      const remainingBeforeRequest = args.timeoutMs - (now() - startedAt);
      if (remainingBeforeRequest <= 0) {
        deadlineReached = true;
        break;
      }
      const requestController = new AbortController();
      const response = await settleBeforeDeadline(
        args.client.callWithMeta('organization.commands.getCommands', {
          tenantId: args.tenantId,
          signal: requestController.signal,
          path: { device_id: args.deviceId },
          query: { page, per_page: 500 }
        }),
        remainingBeforeRequest
      );
      if (response === COMMAND_POLL_DEADLINE) {
        requestController.abort();
        deadlineReached = true;
        break;
      }
      if (now() - startedAt >= args.timeoutMs) {
        requestController.abort();
        deadlineReached = true;
        break;
      }
      const commandPageResult = commandPage(response.data);
      command = commandPageResult.rows.find((row) => row.id === args.commandId);
      if (command || !commandPageResult.hasNextPage) break;
      page += 1;
    }

    if (deadlineReached) break;

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
