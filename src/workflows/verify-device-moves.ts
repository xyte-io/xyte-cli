import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import type { XyteClient } from '../types/client';
import { loadInputRows, type UtilityInputFormat } from '../utils/input-parser';
import {
  parseDeviceRecord,
  parseOptionalLabel,
  parseRequiredInteger,
  requireNonEmptyString
} from './device-move-shared';

export const DEVICE_MOVE_VERIFICATION_SCHEMA_VERSION = 'xyte.device.move-verification.v1' as const;

const DeviceMoveVerificationRowSchema = z.object({
  rowIndex: z.number(),
  deviceId: z.string(),
  deviceName: z.string().optional(),
  targetSpaceId: z.number(),
  actualSpaceId: z.number().optional(),
  status: z.enum(['verified', 'mismatched', 'missing']),
  detail: z.string()
});

export const DeviceMoveVerificationResultSchema = z.object({
  schemaVersion: z.literal(DEVICE_MOVE_VERIFICATION_SCHEMA_VERSION),
  generatedAtUtc: z.string(),
  tenantId: z.string(),
  inputPath: z.string(),
  outputPath: z.string(),
  totals: z.object({
    rows: z.number(),
    verified: z.number(),
    mismatched: z.number(),
    missing: z.number()
  }),
  allVerified: z.boolean(),
  rows: z.array(DeviceMoveVerificationRowSchema)
});

export type DeviceMoveVerificationResult = z.infer<typeof DeviceMoveVerificationResultSchema>;

export function parseMoveVerificationResult(value: unknown): DeviceMoveVerificationResult {
  const parsed = DeviceMoveVerificationResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('Verification input must be produced by the device migration verify_moved_devices step.');
  }
  return parsed.data;
}

export async function runVerifyMovedDevices(args: {
  client: XyteClient;
  tenantId: string;
  inputPath: string;
  outputPath: string;
  inputFormat?: UtilityInputFormat;
}): Promise<DeviceMoveVerificationResult> {
  const rows = loadInputRows(args.inputPath, args.inputFormat ?? 'auto').rows;
  const verificationRows: DeviceMoveVerificationResult['rows'] = [];

  for (let index = 0; index < rows.length; index += 1) {
    const rowIndex = index + 1;
    const deviceId = requireNonEmptyString(rows[index].device_id, 'device_id', rowIndex);
    const targetSpaceId = parseRequiredInteger(rows[index].target_space_id, 'target_space_id', rowIndex);
    const fallbackDeviceName = parseOptionalLabel(rows[index].device_name);

    try {
      const response = await args.client.callWithMeta('organization.devices.getDevice', {
        tenantId: args.tenantId,
        path: { device_id: deviceId }
      });
      const device = parseDeviceRecord(response.data, deviceId);

      if (device.currentSpaceId === undefined) {
        verificationRows.push({
          rowIndex,
          deviceId,
          deviceName: device.name ?? fallbackDeviceName,
          targetSpaceId,
          status: 'missing',
          detail: `Device ${deviceId} did not expose a current space.`
        });
        continue;
      }

      if (device.currentSpaceId === targetSpaceId) {
        verificationRows.push({
          rowIndex,
          deviceId,
          deviceName: device.name ?? fallbackDeviceName,
          targetSpaceId,
          actualSpaceId: device.currentSpaceId,
          status: 'verified',
          detail: `Device ${deviceId} is assigned to space ${targetSpaceId}.`
        });
        continue;
      }

      verificationRows.push({
        rowIndex,
        deviceId,
        deviceName: device.name ?? fallbackDeviceName,
        targetSpaceId,
        actualSpaceId: device.currentSpaceId,
        status: 'mismatched',
        detail: `Device ${deviceId} is assigned to space ${device.currentSpaceId}, expected ${targetSpaceId}.`
      });
    } catch (error) {
      verificationRows.push({
        rowIndex,
        deviceId,
        deviceName: fallbackDeviceName,
        targetSpaceId,
        status: 'missing',
        detail: error instanceof Error && error.message.trim() ? error.message : `Device ${deviceId} could not be fetched.`
      });
    }
  }

  const totals = {
    rows: verificationRows.length,
    verified: verificationRows.filter((row) => row.status === 'verified').length,
    mismatched: verificationRows.filter((row) => row.status === 'mismatched').length,
    missing: verificationRows.filter((row) => row.status === 'missing').length
  };

  const result: DeviceMoveVerificationResult = {
    schemaVersion: DEVICE_MOVE_VERIFICATION_SCHEMA_VERSION,
    generatedAtUtc: new Date().toISOString(),
    tenantId: args.tenantId,
    inputPath: resolve(args.inputPath),
    outputPath: resolve(args.outputPath),
    totals,
    allVerified: totals.rows > 0 ? totals.verified === totals.rows : true,
    rows: verificationRows
  };

  await writeFile(args.outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return result;
}
