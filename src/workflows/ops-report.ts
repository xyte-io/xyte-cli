import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { ensureParentDir } from '../utils/fs';
import { CliUserError } from '../contracts/user-error';
import {
  DEVICE_MATCH_SCHEMA_VERSION,
  INSPECT_DEEP_DIVE_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION
} from '../contracts/versions';
import { DeviceMatchResultSchema, formatDeviceMatchReportMarkdown } from './device-match';
import { DeviceMoveBatchReportSchema, formatDeviceMoveBatchReportMarkdown } from './device-migration-report';
import { DeepDiveResultSchema, type DeepDiveResult } from '../types/deep-dive';
import { generateFleetReport, type FleetReportResult } from './fleet-insights';

export type OpsReportInput =
  | DeepDiveResult
  | z.infer<typeof DeviceMatchResultSchema>
  | z.infer<typeof DeviceMoveBatchReportSchema>;

export { FleetReportResult };

export function parseDeepDiveForReport(raw: unknown, expectedTenantId?: string): DeepDiveResult {
  const parsed = DeepDiveResultSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliUserError({ summary: 'Input JSON must be produced by `xyte-cli ops inspect deep-dive --output json`.' });
  }

  if (expectedTenantId && parsed.data.tenantId !== expectedTenantId) {
    throw new CliUserError({ summary: `Input tenant mismatch. Expected ${expectedTenantId}, got ${parsed.data.tenantId}.` });
  }

  return parsed.data;
}

export function parseReportInput(raw: unknown, expectedTenantId?: string): OpsReportInput {
  const deepDive = DeepDiveResultSchema.safeParse(raw);
  if (deepDive.success) {
    if (expectedTenantId && deepDive.data.tenantId !== expectedTenantId) {
      throw new CliUserError({ summary: `Input tenant mismatch. Expected ${expectedTenantId}, got ${deepDive.data.tenantId}.` });
    }
    return deepDive.data;
  }

  const deviceMatch = DeviceMatchResultSchema.safeParse(raw);
  if (deviceMatch.success) {
    if (expectedTenantId && deviceMatch.data.tenantId && deviceMatch.data.tenantId !== expectedTenantId) {
      throw new CliUserError({ summary: `Input tenant mismatch. Expected ${expectedTenantId}, got ${deviceMatch.data.tenantId}.` });
    }
    return deviceMatch.data;
  }

  const deviceMoveBatch = DeviceMoveBatchReportSchema.safeParse(raw);
  if (deviceMoveBatch.success) {
    if (expectedTenantId && deviceMoveBatch.data.tenantId !== expectedTenantId) {
      throw new CliUserError({ summary: `Input tenant mismatch. Expected ${expectedTenantId}, got ${deviceMoveBatch.data.tenantId}.` });
    }
    return deviceMoveBatch.data;
  }

  throw new CliUserError({
    summary:
      'Input JSON must be produced by `xyte-cli ops inspect deep-dive --output json`, `xyte-cli util match`, or `xyte-cli util move-devices`.'
  });
}

export async function generateOpsReport(args: {
  input: DeepDiveResult;
  tenantId: string;
  format: 'markdown' | 'pdf';
  outPath: string;
  includeSensitive: boolean;
}): Promise<FleetReportResult>;
export async function generateOpsReport(args: {
  input: z.infer<typeof DeviceMatchResultSchema> | z.infer<typeof DeviceMoveBatchReportSchema>;
  tenantId: string;
  format: 'markdown';
  outPath: string;
  includeSensitive: boolean;
}): Promise<FleetReportResult>;
export async function generateOpsReport(args: {
  input: OpsReportInput;
  tenantId: string;
  format: 'markdown' | 'pdf';
  outPath: string;
  includeSensitive: boolean;
}): Promise<FleetReportResult> {
  if (args.input.schemaVersion === INSPECT_DEEP_DIVE_SCHEMA_VERSION) {
    return generateFleetReport({
      deepDive: args.input,
      format: args.format,
      outPath: args.outPath,
      includeSensitive: args.includeSensitive
    });
  }

  if (args.format === 'pdf') {
    throw new CliUserError({ summary: 'PDF rendering is only supported for deep-dive report input.' });
  }

  ensureParentDir(args.outPath);
  const markdown =
    args.input.schemaVersion === DEVICE_MATCH_SCHEMA_VERSION
      ? formatDeviceMatchReportMarkdown(args.input, args.input.tenantId ?? args.tenantId)
      : formatDeviceMoveBatchReportMarkdown(args.input);
  writeFileSync(args.outPath, markdown, 'utf8');

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    tenantId: args.input.tenantId ?? args.tenantId,
    format: args.format,
    outputPath: resolve(args.outPath),
    includeSensitive: args.includeSensitive
  };
}
