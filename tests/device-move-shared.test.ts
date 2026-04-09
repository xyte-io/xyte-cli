import { describe, expect, it } from 'vitest';

import {
  parseDeviceRecord,
  parseOptionalInteger,
  parseOptionalLabel,
  parseRequiredInteger,
  requireNonEmptyString
} from '../src/workflows/device-move-shared';
import { parseMoveVerificationResult } from '../src/workflows/verify-device-moves';
import { DEVICE_MOVE_VERIFICATION_SCHEMA_VERSION } from '../src/contracts/versions';

describe('requireNonEmptyString', () => {
  it('throws when value is undefined', () => {
    expect(() => requireNonEmptyString(undefined, 'device_id', 1)).toThrow(
      'Row 1: field "device_id" must be a string or number.'
    );
  });

  it('throws when string is empty', () => {
    expect(() => requireNonEmptyString('  ', 'device_id', 2)).toThrow(
      'Row 2: field "device_id" cannot be empty.'
    );
  });

  it('returns trimmed string for valid input', () => {
    expect(requireNonEmptyString('  abc  ', 'device_id', 1)).toBe('abc');
  });

  it('converts number to string', () => {
    expect(requireNonEmptyString(42, 'count', 1)).toBe('42');
  });
});

describe('parseRequiredInteger', () => {
  it('accepts a valid positive integer', () => {
    expect(parseRequiredInteger(5, 'space_id', 1)).toBe(5);
  });

  it('throws for non-integer number', () => {
    expect(() => parseRequiredInteger(3.5, 'space_id', 1)).toThrow();
  });

  it('parses integer string', () => {
    expect(parseRequiredInteger('10', 'space_id', 1)).toBe(10);
  });
});

describe('parseOptionalInteger', () => {
  it('returns integer for valid number', () => {
    expect(parseOptionalInteger(7)).toBe(7);
  });

  it('returns undefined for non-integer string', () => {
    expect(parseOptionalInteger('abc')).toBeUndefined();
  });

  it('returns undefined for undefined', () => {
    expect(parseOptionalInteger(undefined)).toBeUndefined();
  });
});

describe('parseOptionalLabel', () => {
  it('returns trimmed string for valid string', () => {
    expect(parseOptionalLabel('  hello  ')).toBe('hello');
  });

  it('returns undefined for empty string', () => {
    expect(parseOptionalLabel('')).toBeUndefined();
  });

  it('returns undefined for non-string/number', () => {
    expect(parseOptionalLabel(null)).toBeUndefined();
    expect(parseOptionalLabel({})).toBeUndefined();
  });
});

describe('parseDeviceRecord', () => {
  it('returns id, name, and currentSpaceId from a flat record', () => {
    const result = parseDeviceRecord({ name: 'My Device', space_id: 5 }, 'dev-1');
    expect(result).toEqual({ id: 'dev-1', name: 'My Device', currentSpaceId: 5 });
  });

  it('extracts space id from nested space object', () => {
    const result = parseDeviceRecord({ space: { id: 10 } }, 'dev-2');
    expect(result.currentSpaceId).toBe(10);
  });

  it('returns undefined name and currentSpaceId when absent', () => {
    const result = parseDeviceRecord({}, 'dev-3');
    expect(result).toEqual({ id: 'dev-3', name: undefined, currentSpaceId: undefined });
  });

  it('throws when data is not a record', () => {
    expect(() => parseDeviceRecord(null, 'dev-4')).toThrow('Device dev-4 returned an unexpected response payload.');
    expect(() => parseDeviceRecord('bad', 'dev-5')).toThrow('Device dev-5 returned an unexpected response payload.');
  });
});

describe('parseMoveVerificationResult', () => {
  const validResult = {
    schemaVersion: DEVICE_MOVE_VERIFICATION_SCHEMA_VERSION,
    generatedAtUtc: '2026-01-01T00:00:00.000Z',
    tenantId: 'tenant-1',
    inputPath: '/input.csv',
    outputPath: '/output.json',
    totals: { rows: 1, verified: 1, mismatched: 0, missing: 0 },
    allVerified: true,
    rows: [
      {
        rowIndex: 1,
        deviceId: 'dev-1',
        targetSpaceId: 100,
        status: 'verified' as const,
        detail: 'Device dev-1 is assigned to space 100.'
      }
    ]
  };

  it('accepts a valid result object', () => {
    const result = parseMoveVerificationResult(validResult);
    expect(result.tenantId).toBe('tenant-1');
    expect(result.allVerified).toBe(true);
  });

  it('throws for an invalid schema version', () => {
    expect(() => parseMoveVerificationResult({ ...validResult, schemaVersion: 'bad' })).toThrow();
  });

  it('throws for missing required fields', () => {
    expect(() => parseMoveVerificationResult({ schemaVersion: DEVICE_MOVE_VERIFICATION_SCHEMA_VERSION })).toThrow();
  });
});
