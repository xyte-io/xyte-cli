import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { UTILITY_BATCH_SCHEMA_VERSION } from '../contracts/versions';
import { errorMessage } from '../utils/error-format';
import type { XyteClient, XyteCallResult } from '../types/client';

export type UtilityBatchCommand = 'space.import-tree';

export interface UtilityBatchOperation {
  rowIndex: number;
  input: Record<string, unknown>;
  endpointKey: string;
  request: {
    path?: Record<string, string | number>;
    query?: Record<string, string | number | boolean | null | undefined>;
    body?: unknown;
  };
  validate?: () => void;
  execute: (client: XyteClient, tenantId: string) => Promise<XyteCallResult<unknown>>;
}

export interface UtilityBatchResult {
  schemaVersion: typeof UTILITY_BATCH_SCHEMA_VERSION;
  generatedAtUtc: string;
  tenantId: string;
  command: UtilityBatchCommand;
  mode: 'dry-run' | 'apply';
  totals: {
    rows: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
  stoppedEarly: boolean;
  firstError?: {
    rowIndex: number;
    message: string;
  };
  reportPath?: string;
}

type UtilityRowStatus = 'dry-run' | 'succeeded' | 'failed' | 'skipped';

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(resolve(filePath)), { recursive: true });
}

function writeReportLine(reportPath: string | undefined, payload: Record<string, unknown>): void {
  if (!reportPath) {
    return;
  }
  ensureParentDir(reportPath);
  appendFileSync(reportPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

export async function runUtilityBatch(args: {
  client: XyteClient;
  tenantId: string;
  command: UtilityBatchCommand;
  operations: UtilityBatchOperation[];
  apply: boolean;
  continueOnError: boolean;
  reportPath?: string;
}): Promise<UtilityBatchResult> {
  const mode: UtilityBatchResult['mode'] = args.apply ? 'apply' : 'dry-run';
  const totals = {
    rows: args.operations.length,
    succeeded: 0,
    failed: 0,
    skipped: 0
  };
  let stoppedEarly = false;
  let firstError: UtilityBatchResult['firstError'] | undefined;

  if (args.reportPath) {
    ensureParentDir(args.reportPath);
    writeFileSync(args.reportPath, '', 'utf8');
  }

  if (!args.apply) {
    for (let index = 0; index < args.operations.length; index += 1) {
      const operation = args.operations[index];
      try {
        operation.validate?.();
        totals.skipped += 1;
        writeReportLine(args.reportPath, {
          timestampUtc: new Date().toISOString(),
          rowIndex: operation.rowIndex,
          status: 'dry-run' satisfies UtilityRowStatus,
          endpointKey: operation.endpointKey,
          request: operation.request,
          input: operation.input
        });
      } catch (error) {
        totals.failed += 1;
        const message = errorMessage(error);
        if (!firstError) {
          firstError = {
            rowIndex: operation.rowIndex,
            message
          };
        }
        writeReportLine(args.reportPath, {
          timestampUtc: new Date().toISOString(),
          rowIndex: operation.rowIndex,
          status: 'failed' satisfies UtilityRowStatus,
          endpointKey: operation.endpointKey,
          request: operation.request,
          error: {
            message
          },
          input: operation.input
        });

        if (!args.continueOnError) {
          stoppedEarly = true;
          const remaining = args.operations.slice(index + 1);
          totals.skipped += remaining.length;
          for (const skippedOperation of remaining) {
            writeReportLine(args.reportPath, {
              timestampUtc: new Date().toISOString(),
              rowIndex: skippedOperation.rowIndex,
              status: 'skipped' satisfies UtilityRowStatus,
              endpointKey: skippedOperation.endpointKey,
              request: skippedOperation.request,
              error: {
                message: 'Skipped because processing stopped after first failure (fail-fast mode).'
              },
              input: skippedOperation.input
            });
          }
          break;
        }
      }
    }

    return {
      schemaVersion: UTILITY_BATCH_SCHEMA_VERSION,
      generatedAtUtc: new Date().toISOString(),
      tenantId: args.tenantId,
      command: args.command,
      mode,
      totals,
      stoppedEarly,
      ...(firstError ? { firstError } : {}),
      ...(args.reportPath ? { reportPath: args.reportPath } : {})
    };
  }

  for (let index = 0; index < args.operations.length; index += 1) {
    const operation = args.operations[index];

    try {
      operation.validate?.();
      const response = await operation.execute(args.client, args.tenantId);
      totals.succeeded += 1;
      writeReportLine(args.reportPath, {
        timestampUtc: new Date().toISOString(),
        rowIndex: operation.rowIndex,
        status: 'succeeded' satisfies UtilityRowStatus,
        endpointKey: operation.endpointKey,
        request: operation.request,
        response: {
          status: response.status,
          durationMs: response.durationMs,
          retryCount: response.retryCount,
          data: response.data
        },
        input: operation.input
      });
    } catch (error) {
      totals.failed += 1;
      const message = errorMessage(error);
      if (!firstError) {
        firstError = {
          rowIndex: operation.rowIndex,
          message
        };
      }

      writeReportLine(args.reportPath, {
        timestampUtc: new Date().toISOString(),
        rowIndex: operation.rowIndex,
        status: 'failed' satisfies UtilityRowStatus,
        endpointKey: operation.endpointKey,
        request: operation.request,
        error: {
          message
        },
        input: operation.input
      });

      if (!args.continueOnError) {
        stoppedEarly = true;
        const remaining = args.operations.slice(index + 1);
        totals.skipped += remaining.length;
        for (const skippedOperation of remaining) {
          writeReportLine(args.reportPath, {
            timestampUtc: new Date().toISOString(),
            rowIndex: skippedOperation.rowIndex,
            status: 'skipped' satisfies UtilityRowStatus,
            endpointKey: skippedOperation.endpointKey,
            request: skippedOperation.request,
            error: {
              message: 'Skipped because processing stopped after first failure (fail-fast mode).'
            },
            input: skippedOperation.input
          });
        }
        break;
      }
    }
  }

  return {
    schemaVersion: UTILITY_BATCH_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    tenantId: args.tenantId,
    command: args.command,
    mode,
    totals,
    stoppedEarly,
    ...(firstError ? { firstError } : {}),
    ...(args.reportPath ? { reportPath: args.reportPath } : {})
  };
}
