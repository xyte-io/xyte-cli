import { appendFileSync, writeFileSync } from 'node:fs';

import { z } from 'zod';

import { ensureParentDir } from '../utils/fs';
import { UTILITY_BATCH_SCHEMA_VERSION } from '../contracts/versions';
import { errorMessage } from '../utils/error-format';
import type { XyteClient, XyteCallResult } from '../types/client';

export type UtilityBatchCommand = 'space.import-tree' | 'device.move';

export interface UtilityBatchValidationOutcome {
  skip: true;
  reason: string;
}

export interface UtilityBatchOperation {
  rowIndex: number;
  input: Record<string, unknown>;
  endpointKey: string;
  request: {
    path?: Record<string, string | number>;
    query?: Record<string, string | number | boolean | null | undefined>;
    body?: unknown;
  };
  validate?: (
    client: XyteClient,
    tenantId: string
  ) => void | UtilityBatchValidationOutcome | Promise<void | UtilityBatchValidationOutcome>;
  execute: (client: XyteClient, tenantId: string) => Promise<XyteCallResult<unknown>>;
}

export const UtilityBatchResultSchema = z.object({
  schemaVersion: z.literal(UTILITY_BATCH_SCHEMA_VERSION),
  generatedAtUtc: z.string(),
  tenantId: z.string(),
  command: z.enum(['space.import-tree', 'device.move']),
  mode: z.enum(['dry-run', 'apply']),
  totals: z.object({
    rows: z.number(),
    succeeded: z.number(),
    failed: z.number(),
    skipped: z.number()
  }),
  stoppedEarly: z.boolean(),
  firstError: z
    .object({
      rowIndex: z.number(),
      message: z.string()
    })
    .optional(),
  reportPath: z.string().optional()
});

export type UtilityBatchResult = z.infer<typeof UtilityBatchResultSchema>;

type UtilityRowStatus = 'dry-run' | 'succeeded' | 'failed' | 'skipped';

function writeReportLine(reportPath: string | undefined, payload: Record<string, unknown>): void {
  if (!reportPath) {
    return;
  }
  ensureParentDir(reportPath);
  appendFileSync(reportPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function reportLine(
  operation: UtilityBatchOperation,
  status: UtilityRowStatus,
  extra?: Record<string, unknown>
): Record<string, unknown> {
  return {
    timestampUtc: new Date().toISOString(),
    rowIndex: operation.rowIndex,
    status,
    endpointKey: operation.endpointKey,
    request: operation.request,
    input: operation.input,
    ...extra
  };
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

  for (let index = 0; index < args.operations.length; index += 1) {
    const operation = args.operations[index];

    try {
      const validation = await operation.validate?.(args.client, args.tenantId);
      if (validation?.skip) {
        totals.skipped += 1;
        writeReportLine(args.reportPath, reportLine(operation, 'skipped', { reason: validation.reason }));
        continue;
      }
      if (args.apply) {
        const response = await operation.execute(args.client, args.tenantId);
        totals.succeeded += 1;
        writeReportLine(
          args.reportPath,
          reportLine(operation, 'succeeded', {
            response: {
              status: response.status,
              durationMs: response.durationMs,
              retryCount: response.retryCount,
              data: response.data
            }
          })
        );
      } else {
        totals.succeeded += 1;
        writeReportLine(args.reportPath, reportLine(operation, 'dry-run'));
      }
    } catch (error) {
      totals.failed += 1;
      const message = errorMessage(error);
      if (!firstError) {
        firstError = { rowIndex: operation.rowIndex, message };
      }

      writeReportLine(args.reportPath, reportLine(operation, 'failed', { error: { message } }));

      if (!args.continueOnError) {
        stoppedEarly = true;
        const remaining = args.operations.slice(index + 1);
        totals.skipped += remaining.length;
        for (const skippedOp of remaining) {
          writeReportLine(
            args.reportPath,
            reportLine(skippedOp, 'skipped', {
              error: { message: 'Skipped because processing stopped after first failure (fail-fast mode).' }
            })
          );
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
