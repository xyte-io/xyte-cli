import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { runDeviceMatch } from '../src/workflows/match';

function makeRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('runDeviceMatch', () => {
  it('emits exact matches with confidence 1 for identical names', () => {
    const root = makeRoot('xyte-match-exact-');
    const sourcePath = join(root, 'source.json');
    const targetPath = join(root, 'target.json');
    const outputPath = join(root, 'device-moves.csv');

    writeFileSync(sourcePath, '[{"id":"dev-1","name":"South Wing"}]\n', 'utf8');
    writeFileSync(targetPath, '[{"id":"99592","name":"South Wing"}]\n', 'utf8');

    const result = runDeviceMatch({
      sourcePath,
      targetPath,
      sourceField: 'name',
      targetField: 'name',
      outputPath,
      tenantId: 'acme'
    });

    expect(result.matches).toEqual([
      {
        deviceId: 'dev-1',
        deviceName: 'South Wing',
        targetSpaceId: '99592',
        targetSpaceName: 'South Wing',
        confidence: 1,
        status: 'exact'
      }
    ]);
    expect(readFileSync(outputPath, 'utf8')).toBe(
      'device_id,device_name,target_space_id,target_space_name,confidence\n' + 'dev-1,South Wing,99592,South Wing,1.000\n'
    );
    expect(JSON.parse(readFileSync(`${outputPath}.summary.json`, 'utf8')).schemaVersion).toBe('xyte.device.match.v1');
  });

  it('emits fuzzy matches with confidence between 0 and 1 for close names', () => {
    const root = makeRoot('xyte-match-fuzzy-');
    const sourcePath = join(root, 'source.json');
    const targetPath = join(root, 'target.json');
    const outputPath = join(root, 'device-moves.csv');

    writeFileSync(sourcePath, '[{"id":"dev-1","name":"South Wing Display"}]\n', 'utf8');
    writeFileSync(targetPath, '[{"id":"99592","name":"South Wing"}]\n', 'utf8');

    const result = runDeviceMatch({
      sourcePath,
      targetPath,
      sourceField: 'name',
      targetField: 'name',
      outputPath
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.targetSpaceId).toBe('99592');
    expect(result.matches[0]?.targetSpaceName).toBe('South Wing');
    expect(result.matches[0]?.status).toBe('fuzzy');
    expect(result.matches[0]?.confidence).toBeGreaterThan(0);
    expect(result.matches[0]?.confidence).toBeLessThan(1);
  });

  it('emits unmatched rows when Fuse returns no target', () => {
    const root = makeRoot('xyte-match-unmatched-');
    const sourcePath = join(root, 'source.json');
    const targetPath = join(root, 'target.json');
    const outputPath = join(root, 'device-moves.csv');

    writeFileSync(sourcePath, '[{"id":"dev-1","name":"Unrelated Device Name"}]\n', 'utf8');
    writeFileSync(targetPath, '[{"id":"99592","name":"South Wing"}]\n', 'utf8');

    const result = runDeviceMatch({
      sourcePath,
      targetPath,
      sourceField: 'name',
      targetField: 'name',
      outputPath
    });

    expect(result.matches).toEqual([
      {
        deviceId: 'dev-1',
        deviceName: 'Unrelated Device Name',
        confidence: 0,
        status: 'unmatched'
      }
    ]);
  });

  it('counts exact, fuzzy, and unmatched totals correctly', () => {
    const root = makeRoot('xyte-match-totals-');
    const sourcePath = join(root, 'source.json');
    const targetPath = join(root, 'target.json');
    const outputPath = join(root, 'device-moves.csv');

    writeFileSync(
      sourcePath,
      JSON.stringify([
        { id: 'dev-1', name: 'South Wing' },
        { id: 'dev-2', name: 'South Wing Display' },
        { id: 'dev-3', name: 'Unrelated Device Name' }
      ]) + '\n',
      'utf8'
    );
    writeFileSync(targetPath, '[{"id":"99592","name":"South Wing"}]\n', 'utf8');

    const result = runDeviceMatch({
      sourcePath,
      targetPath,
      sourceField: 'name',
      targetField: 'name',
      outputPath
    });

    expect(result.totals).toEqual({
      rows: 3,
      exact: 1,
      fuzzy: 1,
      unmatched: 1
    });
  });
});
