import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runVerifyMovedDevices } from '../src/workflows/verify-device-moves';
import { makeCallWithMeta, makeXyteClientMock } from './support/typed-mocks';

function makeTempInput(rows: Array<Record<string, string | number>>): string {
  const dir = join(tmpdir(), `verify-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'input.csv');
  const header = Object.keys(rows[0]).join(',');
  const body = rows.map((r) => Object.values(r).join(',')).join('\n');
  writeFileSync(file, `${header}\n${body}`);
  return file;
}

describe('runVerifyMovedDevices', () => {
  it('returns verified when device space matches target', async () => {
    const inputPath = makeTempInput([{ device_id: 'dev-1', target_space_id: 100 }]);
    const outputPath = join(tmpdir(), `verify-out-${Date.now()}.json`);
    const client = makeXyteClientMock({
      callWithMeta: makeCallWithMeta(async () => ({
        status: 200,
        headers: {},
        data: { id: 'dev-1', name: 'Device 1', space_id: 100 },
        durationMs: 1,
        retryCount: 0,
        attempts: 1
      }))
    });

    const result = await runVerifyMovedDevices({
      client,
      tenantId: 'tenant-1',
      inputPath,
      outputPath
    });

    expect(result.rows[0].status).toBe('verified');
    expect(result.allVerified).toBe(true);
  });

  it('returns mismatched when device space differs from target', async () => {
    const inputPath = makeTempInput([{ device_id: 'dev-2', target_space_id: 200 }]);
    const outputPath = join(tmpdir(), `verify-out-${Date.now()}.json`);
    const client = makeXyteClientMock({
      callWithMeta: makeCallWithMeta(async () => ({
        status: 200,
        headers: {},
        data: { id: 'dev-2', name: 'Device 2', space_id: 999 },
        durationMs: 1,
        retryCount: 0,
        attempts: 1
      }))
    });

    const result = await runVerifyMovedDevices({
      client,
      tenantId: 'tenant-1',
      inputPath,
      outputPath
    });

    expect(result.rows[0].status).toBe('mismatched');
    expect(result.allVerified).toBe(false);
  });

  it('returns missing when API throws an error', async () => {
    const inputPath = makeTempInput([{ device_id: 'dev-3', target_space_id: 300 }]);
    const outputPath = join(tmpdir(), `verify-out-${Date.now()}.json`);
    const client = makeXyteClientMock({
      callWithMeta: makeCallWithMeta(async () => {
        throw new Error('Device not found');
      })
    });

    const result = await runVerifyMovedDevices({
      client,
      tenantId: 'tenant-1',
      inputPath,
      outputPath
    });

    expect(result.rows[0].status).toBe('missing');
    expect(result.rows[0].detail).toBe('Device not found');
    expect(result.allVerified).toBe(false);
  });
});
