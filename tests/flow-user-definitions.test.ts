import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  exportFlowDefinition,
  getFlowDefinition,
  importFlowDefinition,
  listFlowDefinitions,
  saveFlowDefinition,
  updateFlowDefinition
} from '../src/workflows/flow-user-definitions';

const SCHEMA = 'xyte.flow.definition.v1';

function makeConfigDir(): string {
  return mkdtempSync(join(tmpdir(), 'xyte-flow-defs-'));
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: SCHEMA,
    id: 'flow.test',
    title: 'Test Flow',
    basedOn: 'device.move',
    defaults: {},
    createdAtUtc: '2025-01-01T00:00:00.000Z',
    updatedAtUtc: '2025-01-01T00:00:00.000Z',
    ...overrides
  };
}

describe('flow-user-definitions', () => {
  let configDir: string;

  beforeEach(() => {
    configDir = makeConfigDir();
    vi.stubEnv('XYTE_CLI_CONFIG_DIR', configDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(configDir, { recursive: true, force: true });
  });

  describe('listFlowDefinitions', () => {
    it('returns empty array when flows dir does not exist', async () => {
      const result = await listFlowDefinitions();
      expect(result).toEqual([]);
    });

    it('returns sorted definitions from flows dir', async () => {
      await saveFlowDefinition({ flowId: 'flow.beta', basedOn: 'device.move', overwrite: false });
      await saveFlowDefinition({ flowId: 'flow.alpha', basedOn: 'device.move', overwrite: false });

      const result = await listFlowDefinitions();
      expect(result.map((d) => d.id)).toEqual(['flow.alpha', 'flow.beta']);
    });

    it('skips non-json files and invalid JSON', async () => {
      const flowsDir = join(configDir, 'flows');
      await saveFlowDefinition({ flowId: 'flow.ok', basedOn: 'device.move', overwrite: false });
      writeFileSync(join(flowsDir, 'readme.txt'), 'ignored');
      writeFileSync(join(flowsDir, 'bad.json'), 'not valid json');

      const result = await listFlowDefinitions();
      expect(result.map((d) => d.id)).toEqual(['flow.ok']);
    });

    it('skips files with wrong schemaVersion', async () => {
      const flowsDir = join(configDir, 'flows');
      await saveFlowDefinition({ flowId: 'flow.ok', basedOn: 'device.move', overwrite: false });
      writeFileSync(
        join(flowsDir, 'flow.old.json'),
        JSON.stringify({ ...validPayload(), id: 'flow.old', schemaVersion: 'xyte.flow.v0' })
      );

      const result = await listFlowDefinitions();
      expect(result.map((d) => d.id)).toEqual(['flow.ok']);
    });
  });

  describe('getFlowDefinition', () => {
    it('returns undefined for missing flow', async () => {
      const result = await getFlowDefinition('flow.missing');
      expect(result).toBeUndefined();
    });

    it('returns definition for existing flow', async () => {
      await saveFlowDefinition({ flowId: 'flow.hello', basedOn: 'device.move', title: 'Hello', overwrite: false });

      const result = await getFlowDefinition('flow.hello');
      expect(result).toBeDefined();
      expect(result?.id).toBe('flow.hello');
      expect(result?.title).toBe('Hello');
    });
  });

  describe('saveFlowDefinition', () => {
    it('creates a new flow definition', async () => {
      const result = await saveFlowDefinition({
        flowId: 'flow.new',
        basedOn: 'device.move',
        title: 'New Flow',
        defaults: { tenant: 'acme' },
        overwrite: false
      });

      expect(result.status).toBe('created');
      expect(result.id).toBe('flow.new');
      expect(result.basedOn).toBe('device.move');
      expect(result.defaults).toEqual({ tenant: 'acme' });
    });

    it('throws when flow exists and overwrite is false', async () => {
      await saveFlowDefinition({ flowId: 'flow.dup', basedOn: 'device.move', overwrite: false });

      await expect(saveFlowDefinition({ flowId: 'flow.dup', basedOn: 'device.move', overwrite: false })).rejects.toThrow(
        'already exists'
      );
    });

    it('updates existing flow when overwrite is true', async () => {
      await saveFlowDefinition({ flowId: 'flow.upd', basedOn: 'device.move', title: 'Old', overwrite: false });

      const result = await saveFlowDefinition({
        flowId: 'flow.upd',
        basedOn: 'device.inspect',
        title: 'New',
        overwrite: true
      });

      expect(result.status).toBe('updated');
      expect(result.title).toBe('New');
      expect(result.basedOn).toBe('device.inspect');
    });

    it('preserves createdAtUtc across overwrites', async () => {
      const first = await saveFlowDefinition({ flowId: 'flow.ts', basedOn: 'device.move', overwrite: false });
      const second = await saveFlowDefinition({ flowId: 'flow.ts', basedOn: 'device.move', overwrite: true });

      expect(second.createdAtUtc).toBe(first.createdAtUtc);
    });

    it('rejects invalid flow id', async () => {
      await expect(saveFlowDefinition({ flowId: 'bad-id', basedOn: 'device.move', overwrite: false })).rejects.toThrow(
        'Invalid flow id'
      );
    });
  });

  describe('updateFlowDefinition', () => {
    it('throws when flow does not exist', async () => {
      await expect(updateFlowDefinition({ flowId: 'flow.ghost' })).rejects.toThrow('Unknown flow definition');
    });

    it('merges defaults by default', async () => {
      await saveFlowDefinition({
        flowId: 'flow.merge',
        basedOn: 'device.move',
        defaults: { a: '1', b: '2' },
        overwrite: false
      });

      const result = await updateFlowDefinition({ flowId: 'flow.merge', defaults: { b: 'updated', c: '3' } });

      expect(result.defaults).toEqual({ a: '1', b: 'updated', c: '3' });
    });

    it('replaces defaults when replaceDefaults is true', async () => {
      await saveFlowDefinition({
        flowId: 'flow.replace',
        basedOn: 'device.move',
        defaults: { a: '1', b: '2' },
        overwrite: false
      });

      const result = await updateFlowDefinition({
        flowId: 'flow.replace',
        defaults: { c: '3' },
        replaceDefaults: true
      });

      expect(result.defaults).toEqual({ c: '3' });
    });

    it('preserves existing fields when not provided', async () => {
      await saveFlowDefinition({
        flowId: 'flow.partial',
        basedOn: 'device.move',
        title: 'Original',
        description: 'Desc',
        overwrite: false
      });

      const result = await updateFlowDefinition({ flowId: 'flow.partial' });

      expect(result.title).toBe('Original');
      expect(result.description).toBe('Desc');
    });
  });

  describe('exportFlowDefinition', () => {
    it('throws when flow does not exist', async () => {
      const outPath = join(configDir, 'out.json');
      await expect(exportFlowDefinition({ flowId: 'flow.missing', outPath })).rejects.toThrow('Unknown flow definition');
    });

    it('writes flow JSON to output path', async () => {
      await saveFlowDefinition({ flowId: 'flow.export', basedOn: 'device.move', title: 'Export Me', overwrite: false });
      const outPath = join(configDir, 'exported.json');

      const result = await exportFlowDefinition({ flowId: 'flow.export', outPath });

      expect(result.outPath).toBe(outPath);
      expect(result.flow.id).toBe('flow.export');
      expect(result.flow.title).toBe('Export Me');
    });
  });

  describe('importFlowDefinition', () => {
    it('throws on missing file', async () => {
      const missing = join(configDir, 'no-such-file.json');
      await expect(importFlowDefinition({ filePath: missing, force: false })).rejects.toThrow('read');
    });

    it('throws on invalid JSON', async () => {
      const bad = join(configDir, 'bad.json');
      writeFileSync(bad, 'not json');
      await expect(importFlowDefinition({ filePath: bad, force: false })).rejects.toThrow('parse');
    });

    it('throws on invalid schema', async () => {
      const invalid = join(configDir, 'invalid.json');
      writeFileSync(invalid, JSON.stringify({ schemaVersion: 'wrong', id: 'flow.x', basedOn: 'x' }));
      await expect(importFlowDefinition({ filePath: invalid, force: false })).rejects.toThrow('schemaVersion');
    });

    it('imports a valid flow definition', async () => {
      const src = join(configDir, 'import-me.json');
      writeFileSync(src, JSON.stringify(validPayload({ id: 'flow.imported', title: 'Imported' })));

      const result = await importFlowDefinition({ filePath: src, force: false });

      expect(result.id).toBe('flow.imported');
      expect(result.status).toBe('created');
    });

    it('respects force flag on conflict', async () => {
      await saveFlowDefinition({ flowId: 'flow.conflict', basedOn: 'device.move', overwrite: false });

      const src = join(configDir, 'conflict.json');
      writeFileSync(src, JSON.stringify(validPayload({ id: 'flow.conflict', title: 'Overwritten' })));

      await expect(importFlowDefinition({ filePath: src, force: false })).rejects.toThrow('already exists');

      const result = await importFlowDefinition({ filePath: src, force: true });
      expect(result.status).toBe('updated');
      expect(result.title).toBe('Overwritten');
    });
  });
});
