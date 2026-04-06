import type { XyteClient } from '../types/client';
import { loadInputRows, type UtilityInputFormat } from '../utils/input-parser';
import { isRecord } from '../utils/json';
import { runUtilityBatch, type UtilityBatchOperation, type UtilityBatchResult } from './utility-batch';

function requireNonEmptyString(value: unknown, fieldName: string, rowIndex: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`Row ${rowIndex}: field "${fieldName}" must be a string or number.`);
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    throw new Error(`Row ${rowIndex}: field "${fieldName}" cannot be empty.`);
  }
  return trimmed;
}

function parseRequiredInteger(value: unknown, fieldName: string, rowIndex: number): number {
  const normalized = requireNonEmptyString(value, fieldName, rowIndex);
  const parsed = Number.parseInt(normalized, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Row ${rowIndex}: field "${fieldName}" must be a positive integer.`);
  }
  return parsed;
}

function parseOptionalInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function parseDeviceRecord(data: unknown, deviceId: string): { id: string; name?: string; currentSpaceId?: number } {
  if (!isRecord(data)) {
    throw new Error(`Device ${deviceId} returned an unexpected response payload.`);
  }

  const nestedSpace = isRecord(data.space) ? data.space : undefined;
  return {
    id: deviceId,
    name: typeof data.name === 'string' ? data.name.trim() || undefined : undefined,
    currentSpaceId: parseOptionalInteger(data.space_id ?? nestedSpace?.id)
  };
}

function extractSpaceRecord(data: unknown, spaceId: number): { id: number; name?: string } {
  if (!isRecord(data)) {
    throw new Error(`Space ${spaceId} returned an unexpected response payload.`);
  }

  const items = Array.isArray(data.items) ? data.items : [];
  const candidate = items.find((item) => parseOptionalInteger(isRecord(item) ? item.id : undefined) === spaceId);
  if (candidate && isRecord(candidate)) {
    return {
      id: spaceId,
      name: typeof candidate.name === 'string' ? candidate.name.trim() || undefined : undefined
    };
  }

  if (parseOptionalInteger(data.id) === spaceId) {
    return {
      id: spaceId,
      name: typeof data.name === 'string' ? data.name.trim() || undefined : undefined
    };
  }

  throw new Error(`Target space ${spaceId} was not found.`);
}

export async function runMoveDevices(args: {
  client: XyteClient;
  tenantId: string;
  inputPath: string;
  inputFormat?: UtilityInputFormat;
  apply: boolean;
  continueOnError: boolean;
  reportPath?: string;
}): Promise<UtilityBatchResult> {
  const rows = loadInputRows(args.inputPath, args.inputFormat ?? 'auto').rows;
  const deviceCounts = new Map<string, number>();

  for (let index = 0; index < rows.length; index += 1) {
    const deviceId = requireNonEmptyString(rows[index].device_id, 'device_id', index + 1);
    deviceCounts.set(deviceId, (deviceCounts.get(deviceId) ?? 0) + 1);
  }

  const duplicateDeviceIds = new Set(
    Array.from(deviceCounts.entries())
      .filter(([, count]) => count > 1)
      .map(([deviceId]) => deviceId)
  );

  const deviceCache = new Map<string, Promise<{ id: string; name?: string; currentSpaceId?: number }>>();
  const spaceCache = new Map<number, Promise<{ id: number; name?: string }>>();

  const loadDevice = (deviceId: string) => {
    if (!deviceCache.has(deviceId)) {
      deviceCache.set(
        deviceId,
        args.client
          .callWithMeta('organization.devices.getDevice', {
            tenantId: args.tenantId,
            path: { device_id: deviceId }
          })
          .then((response) => parseDeviceRecord(response.data, deviceId))
      );
    }
    return deviceCache.get(deviceId)!;
  };

  const loadSpace = (spaceId: number) => {
    if (!spaceCache.has(spaceId)) {
      spaceCache.set(
        spaceId,
        args.client
          .callWithMeta('organization.spaces.getSpaces', {
            tenantId: args.tenantId,
            query: { id: spaceId }
          })
          .then((response) => extractSpaceRecord(response.data, spaceId))
      );
    }
    return spaceCache.get(spaceId)!;
  };

  const operations: UtilityBatchOperation[] = rows.map((row, index) => {
    const rowIndex = index + 1;
    const previewDeviceId = typeof row.device_id === 'string' || typeof row.device_id === 'number' ? String(row.device_id) : '';
    const previewTargetSpaceId = parseOptionalInteger(row.target_space_id);
    let prepared:
      | {
          deviceId: string;
          targetSpaceId: number;
        }
      | undefined;

    const prepare = async () => {
      if (prepared) {
        return prepared;
      }

      const deviceId = requireNonEmptyString(row.device_id, 'device_id', rowIndex);
      if (duplicateDeviceIds.has(deviceId)) {
        throw new Error(`Row ${rowIndex}: device_id "${deviceId}" is duplicated in the input.`);
      }
      const targetSpaceId = parseRequiredInteger(row.target_space_id, 'target_space_id', rowIndex);
      const device = await loadDevice(deviceId);
      await loadSpace(targetSpaceId);

      prepared = { deviceId: device.id, targetSpaceId };
      if (device.currentSpaceId === targetSpaceId) {
        return prepared;
      }
      return prepared;
    };

    return {
      rowIndex,
      input: row,
      endpointKey: 'organization.devices.moveDevice',
      request: {
        path: {
          device_id: previewDeviceId || '<device_id>'
        },
        body: {
          space_id: previewTargetSpaceId ?? row.target_space_id ?? '<target_space_id>'
        }
      },
      validate: async () => {
        const preparedRow = await prepare();
        const device = await loadDevice(preparedRow.deviceId);
        if (device.currentSpaceId === preparedRow.targetSpaceId) {
          return {
            skip: true,
            reason: `Device ${preparedRow.deviceId} is already assigned to space ${preparedRow.targetSpaceId}.`
          };
        }
        return undefined;
      },
      execute: async (client, tenantId) => {
        const preparedRow = await prepare();
        return client.callWithMeta('organization.devices.moveDevice', {
          tenantId,
          path: {
            device_id: preparedRow.deviceId
          },
          body: {
            space_id: preparedRow.targetSpaceId
          }
        });
      }
    };
  });

  return runUtilityBatch({
    client: args.client,
    tenantId: args.tenantId,
    command: 'device.move',
    operations,
    apply: args.apply,
    continueOnError: args.continueOnError,
    reportPath: args.reportPath
  });
}
