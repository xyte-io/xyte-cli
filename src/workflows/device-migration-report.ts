import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

import { ensureParentDir } from '../utils/fs';
import { asRecord } from '../utils/json';
import { REPORT_SCHEMA_VERSION } from '../contracts/versions';
import { UtilityBatchResultSchema } from './utility-batch';
import { parseMoveVerificationResult } from './verify-device-moves';
import type { FleetInspectResult } from '../types/fleet-inspect';

export const DeviceMoveBatchReportSchema = UtilityBatchResultSchema.extend({
  command: z.literal('device.move')
});

export const DeviceMigrationReportResultSchema = z.object({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  generatedAtUtc: z.string(),
  tenantId: z.string(),
  format: z.literal('markdown'),
  outputPath: z.string(),
  includeSensitive: z.boolean()
});

export type DeviceMigrationReportResult = z.infer<typeof DeviceMigrationReportResultSchema>;

function toSafeInt(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

export function extractFleetTotals(value: unknown): FleetInspectResult['totals'] {
  const record = asRecord(value);
  const totals = asRecord(record.totals);
  return {
    devices: toSafeInt(totals.devices),
    spaces: toSafeInt(totals.spaces),
    incidents: toSafeInt(totals.incidents),
    tickets: toSafeInt(totals.tickets)
  };
}

export function generateDeviceMigrationReport(args: {
  execution: z.infer<typeof DeviceMoveBatchReportSchema>;
  fleet: unknown;
  verification: unknown;
  tenantId: string;
  outPath: string;
}): DeviceMigrationReportResult {
  const fleetTotals = extractFleetTotals(args.fleet);
  const verification = parseMoveVerificationResult(args.verification);
  const issueRows = verification.rows.filter((row) => row.status !== 'verified');
  ensureParentDir(args.outPath);

  const lines = [
    '# Device Migration Post-Execution Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    `Tenant: ${args.tenantId}`,
    '',
    '## Execution',
    `- Mode: ${args.execution.mode}`,
    `- Rows: ${args.execution.totals.rows}`,
    `- Succeeded: ${args.execution.totals.succeeded}`,
    `- Failed: ${args.execution.totals.failed}`,
    `- Skipped: ${args.execution.totals.skipped}`,
    `- Stopped early: ${args.execution.stoppedEarly ? 'yes' : 'no'}`,
    '',
    '## Verification',
    `- Planned rows: ${verification.totals.rows}`,
    `- Verified: ${verification.totals.verified}`,
    `- Mismatched: ${verification.totals.mismatched}`,
    `- Missing: ${verification.totals.missing}`,
    '',
    '## Fleet Snapshot',
    `- Fleet devices: ${fleetTotals.devices}`,
    `- Fleet spaces: ${fleetTotals.spaces}`,
    `- Fleet incidents: ${fleetTotals.incidents}`,
    `- Fleet tickets: ${fleetTotals.tickets}`
  ];

  if (args.execution.reportPath) {
    lines.push(`- NDJSON report: ${args.execution.reportPath}`);
  }
  if (args.execution.firstError) {
    lines.push('', '## First Error', `- Row ${args.execution.firstError.rowIndex}: ${args.execution.firstError.message}`);
  }
  if (issueRows.length > 0) {
    lines.push('', '## Verification Issues', '', '| Row | Device | Target Space | Actual Space | Status | Detail |');
    lines.push('| ---: | --- | ---: | ---: | --- | --- |');
    issueRows.forEach((row) => {
      lines.push(
        `| ${row.rowIndex} | ${row.deviceName ?? row.deviceId} (${row.deviceId}) | ${row.targetSpaceId} | ${row.actualSpaceId ?? 'n/a'} | ${row.status} | ${row.detail} |`
      );
    });
  }

  writeFileSync(args.outPath, `${lines.join('\n')}\n`, 'utf8');
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    tenantId: args.tenantId,
    format: 'markdown',
    outputPath: resolve(args.outPath),
    includeSensitive: false
  };
}

export function formatDeviceMoveBatchReportMarkdown(result: z.infer<typeof DeviceMoveBatchReportSchema>): string {
  const succeededLabel = result.mode === 'dry-run' ? 'Ready to apply' : 'Succeeded';
  const lines = [
    '# Device Migration Execution Report',
    '',
    `Generated: ${result.generatedAtUtc}`,
    `Tenant: ${result.tenantId}`,
    '',
    '## Execution',
    `- Mode: ${result.mode}`,
    `- Rows: ${result.totals.rows}`,
    `- ${succeededLabel}: ${result.totals.succeeded}`,
    `- Failed: ${result.totals.failed}`,
    `- Skipped: ${result.totals.skipped}`,
    `- Stopped early: ${result.stoppedEarly ? 'yes' : 'no'}`
  ];

  if (result.reportPath) {
    lines.push(`- NDJSON report: ${result.reportPath}`);
  }
  if (result.firstError) {
    lines.push('', '## First Error', `- Row ${result.firstError.rowIndex}: ${result.firstError.message}`);
  }

  return `${lines.join('\n')}\n`;
}
