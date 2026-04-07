import { isRecord } from '../utils/json';

export function requireNonEmptyString(value: unknown, fieldName: string, rowIndex: number): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`Row ${rowIndex}: field "${fieldName}" must be a string or number.`);
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    throw new Error(`Row ${rowIndex}: field "${fieldName}" cannot be empty.`);
  }
  return trimmed;
}

export function parseRequiredInteger(value: unknown, fieldName: string, rowIndex: number): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Row ${rowIndex}: field "${fieldName}" must be a positive integer.`);
    }
    return value;
  }

  const normalized = requireNonEmptyString(value, fieldName, rowIndex);
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Row ${rowIndex}: field "${fieldName}" must be a positive integer.`);
  }
  return Number(normalized);
}

export function parseOptionalInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

export function parseOptionalLabel(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

export function parseDeviceRecord(data: unknown, deviceId: string): { id: string; name?: string; currentSpaceId?: number } {
  if (!isRecord(data)) {
    throw new Error(`Device ${deviceId} returned an unexpected response payload.`);
  }

  const nestedSpace = isRecord(data.space) ? data.space : undefined;
  return {
    id: deviceId,
    name: parseOptionalLabel(data.name),
    currentSpaceId: parseOptionalInteger(data.space_id ?? nestedSpace?.id)
  };
}
