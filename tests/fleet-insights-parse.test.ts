import { describe, it, expect } from 'vitest';
import { parseReportInput, parseDeepDiveForReport } from '../src/workflows/ops-report';
import { CliUserError } from '../src/contracts/user-error';
import {
  INSPECT_DEEP_DIVE_SCHEMA_VERSION,
  DEVICE_MATCH_SCHEMA_VERSION,
  UTILITY_BATCH_SCHEMA_VERSION
} from '../src/contracts/versions';

const DEEP_DIVE_BASE = {
  schemaVersion: INSPECT_DEEP_DIVE_SCHEMA_VERSION,
  generatedAtUtc: '2026-01-01T00:00:00.000Z',
  tenantId: 'acme',
  windowHours: 24,
  summary: [],
  topOfflineSpaces: [],
  topIncidentDevices: [],
  activeIncidentAging: [],
  churnWindow: { incidents: 0, devices: 0, spaces: 0, bySpace: [], byDevice: [] },
  ticketPosture: { openTickets: 0, overlappingActiveIncidentDevices: 0, oldestOpenTickets: [] },
  dataQuality: { statusMismatches: [] }
};

const DEVICE_MATCH_BASE = {
  schemaVersion: DEVICE_MATCH_SCHEMA_VERSION,
  generatedAtUtc: '2026-01-01T00:00:00.000Z',
  tenantId: 'acme',
  sourcePath: '/tmp/source.csv',
  targetPath: '/tmp/target.csv',
  sourceField: 'serial',
  targetField: 'serial',
  outputPath: '/tmp/output.csv',
  summaryPath: '/tmp/summary.json',
  totals: { rows: 0, exact: 0, fuzzy: 0, unmatched: 0 },
  matches: []
};

const DEVICE_MOVE_BASE = {
  schemaVersion: UTILITY_BATCH_SCHEMA_VERSION,
  generatedAtUtc: '2026-01-01T00:00:00.000Z',
  tenantId: 'acme',
  command: 'device.move',
  mode: 'apply',
  totals: { rows: 1, planned: 0, succeeded: 1, failed: 0, skipped: 0 },
  stoppedEarly: false
};

describe('parseDeepDiveForReport', () => {
  it('parses valid deep-dive input', () => {
    const result = parseDeepDiveForReport(DEEP_DIVE_BASE);
    expect(result.schemaVersion).toBe(INSPECT_DEEP_DIVE_SCHEMA_VERSION);
    expect(result.tenantId).toBe('acme');
  });

  it('throws on non-deep-dive input', () => {
    expect(() => parseDeepDiveForReport({ schemaVersion: 'xyte.other.v1' })).toThrow(CliUserError);
  });

  it('throws on tenant mismatch', () => {
    expect(() => parseDeepDiveForReport(DEEP_DIVE_BASE, 'other-tenant')).toThrow(CliUserError);
  });

  it('accepts matching tenant', () => {
    const result = parseDeepDiveForReport(DEEP_DIVE_BASE, 'acme');
    expect(result.tenantId).toBe('acme');
  });
});

describe('parseReportInput', () => {
  it('parses valid deep-dive input', () => {
    const result = parseReportInput(DEEP_DIVE_BASE);
    expect(result.schemaVersion).toBe(INSPECT_DEEP_DIVE_SCHEMA_VERSION);
  });

  it('parses valid device-match input', () => {
    const result = parseReportInput(DEVICE_MATCH_BASE);
    expect(result.schemaVersion).toBe(DEVICE_MATCH_SCHEMA_VERSION);
  });

  it('parses valid device-move-batch input', () => {
    const result = parseReportInput(DEVICE_MOVE_BASE);
    expect(result.schemaVersion).toBe(UTILITY_BATCH_SCHEMA_VERSION);
  });

  it('throws on unrecognized payload', () => {
    expect(() => parseReportInput({ schemaVersion: 'xyte.unknown.v1' })).toThrow(CliUserError);
    expect(() => parseReportInput(null)).toThrow(CliUserError);
    expect(() => parseReportInput('not an object')).toThrow(CliUserError);
  });

  it('throws on deep-dive tenant mismatch', () => {
    expect(() => parseReportInput(DEEP_DIVE_BASE, 'other')).toThrow(CliUserError);
  });

  it('throws on device-match tenant mismatch when tenantId is set', () => {
    expect(() => parseReportInput(DEVICE_MATCH_BASE, 'other')).toThrow(CliUserError);
  });

  it('throws on device-move tenant mismatch', () => {
    expect(() => parseReportInput(DEVICE_MOVE_BASE, 'other')).toThrow(CliUserError);
  });

  it('accepts matching tenant on all variants', () => {
    expect(() => parseReportInput(DEEP_DIVE_BASE, 'acme')).not.toThrow();
    expect(() => parseReportInput(DEVICE_MATCH_BASE, 'acme')).not.toThrow();
    expect(() => parseReportInput(DEVICE_MOVE_BASE, 'acme')).not.toThrow();
  });
});
