import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';

import { generateDeviceMigrationReport, extractFleetTotals } from '../src/workflows/device-migration-report';
import { UTILITY_BATCH_SCHEMA_VERSION } from '../src/contracts/versions';
import { DEVICE_MOVE_VERIFICATION_SCHEMA_VERSION } from '../src/workflows/verify-device-moves';
import { REPORT_SCHEMA_VERSION } from '../src/contracts/versions';

const executionFixture = {
  schemaVersion: UTILITY_BATCH_SCHEMA_VERSION as typeof UTILITY_BATCH_SCHEMA_VERSION,
  generatedAtUtc: '2026-01-01T00:00:00.000Z',
  tenantId: 'tenant-1',
  command: 'device.move' as const,
  mode: 'apply' as const,
  totals: { rows: 3, succeeded: 2, failed: 1, skipped: 0 },
  stoppedEarly: false
};

const verificationFixture = {
  schemaVersion: DEVICE_MOVE_VERIFICATION_SCHEMA_VERSION,
  generatedAtUtc: '2026-01-01T00:01:00.000Z',
  tenantId: 'tenant-1',
  inputPath: '/tmp/input.csv',
  outputPath: '/tmp/output.json',
  totals: { rows: 2, verified: 2, mismatched: 0, missing: 0 },
  allVerified: true,
  rows: [
    { rowIndex: 1, deviceId: 'dev-a', targetSpaceId: 10, actualSpaceId: 10, status: 'verified' as const, detail: 'ok' },
    { rowIndex: 2, deviceId: 'dev-b', targetSpaceId: 20, actualSpaceId: 20, status: 'verified' as const, detail: 'ok' }
  ]
};

const fleetFixture = {
  totals: { devices: 42, spaces: 5, incidents: 1, tickets: 3 }
};

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  tmpDirs = [];
});

describe('extractFleetTotals', () => {
  it('extracts totals from a nested fleet object', () => {
    const result = extractFleetTotals(fleetFixture);
    expect(result).toEqual({ devices: 42, spaces: 5, incidents: 1, tickets: 3 });
  });

  it('returns zeros for missing fields', () => {
    const result = extractFleetTotals({ totals: {} });
    expect(result).toEqual({ devices: 0, spaces: 0, incidents: 0, tickets: 0 });
  });

  it('returns zeros for null/undefined input', () => {
    const result = extractFleetTotals(null);
    expect(result).toEqual({ devices: 0, spaces: 0, incidents: 0, tickets: 0 });
  });

  it('coerces string numbers', () => {
    const result = extractFleetTotals({ totals: { devices: '7', spaces: '2', incidents: '0', tickets: '1' } });
    expect(result).toEqual({ devices: 7, spaces: 2, incidents: 0, tickets: 1 });
  });
});

describe('generateDeviceMigrationReport', () => {
  it('writes a markdown file and returns the expected schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmr-test-'));
    tmpDirs.push(dir);
    const outPath = join(dir, 'report.md');

    const result = generateDeviceMigrationReport({
      execution: executionFixture,
      fleet: fleetFixture,
      verification: verificationFixture,
      tenantId: 'tenant-1',
      outPath
    });

    expect(result.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(result.format).toBe('markdown');
    expect(result.tenantId).toBe('tenant-1');
    expect(result.outputPath).toBeTruthy();

    const content = readFileSync(outPath, 'utf8');
    expect(content).toContain('# Device Migration Post-Execution Report');
    expect(content).toContain('Tenant: tenant-1');
    expect(content).toContain('Rows: 3');
    expect(content).toContain('Fleet devices: 42');
  });

  it('creates intermediate directories if they do not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmr-test-'));
    tmpDirs.push(dir);
    const outPath = join(dir, 'nested', 'deep', 'report.md');

    const result = generateDeviceMigrationReport({
      execution: executionFixture,
      fleet: fleetFixture,
      verification: verificationFixture,
      tenantId: 'tenant-2',
      outPath
    });

    expect(result.outputPath).toContain('report.md');
    const content = readFileSync(outPath, 'utf8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('includes verification issues table when rows are not verified', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmr-test-'));
    tmpDirs.push(dir);
    const outPath = join(dir, 'report.md');

    const verificationWithIssue = {
      ...verificationFixture,
      totals: { rows: 1, verified: 0, mismatched: 1, missing: 0 },
      allVerified: false,
      rows: [
        { rowIndex: 1, deviceId: 'dev-x', targetSpaceId: 99, actualSpaceId: 1, status: 'mismatched' as const, detail: 'wrong space' }
      ]
    };

    generateDeviceMigrationReport({
      execution: executionFixture,
      fleet: fleetFixture,
      verification: verificationWithIssue,
      tenantId: 'tenant-1',
      outPath
    });

    const content = readFileSync(outPath, 'utf8');
    expect(content).toContain('## Verification Issues');
    expect(content).toContain('dev-x');
    expect(content).toContain('wrong space');
  });

  it('throws when verification input is invalid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmr-test-'));
    tmpDirs.push(dir);
    const outPath = join(dir, 'report.md');

    expect(() =>
      generateDeviceMigrationReport({
        execution: executionFixture,
        fleet: fleetFixture,
        verification: { invalid: true },
        tenantId: 'tenant-1',
        outPath
      })
    ).toThrow('Verification input must be produced by the device migration verify_moved_devices step.');
  });
});
