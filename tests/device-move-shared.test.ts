import { describe, expect, it } from 'vitest';

import {
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
