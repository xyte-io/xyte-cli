import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it } from 'vitest';

import { buildUtilityAiContext } from '../src/workflows/utility-ai-context';

function makeTempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('utility ai-context workflow', () => {
  it('builds devices contract with expected mapping metadata', () => {
    const root = makeTempRoot('xyte-ai-context-devices-');
    const inputPath = join(root, 'source.xlsx');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'placeholder', 'utf8');

    const result = buildUtilityAiContext({
      inputPath,
      entity: 'devices',
      outputDir: outDir,
      tenantId: 'acme'
    });

    expect(result.schemaVersion).toBe('xyte.utility.ai-context.v1');
    expect(result.entity).toBe('devices');
    expect(result.mappedAction).toBe('device.bulk-rename');
    expect(result.input.kind).toBe('tabular');
    expect(result.promptTemplatePath).toContain('ai-bulk-rename.prompt.md');
    expect(result.skillNodePath).toContain('utility-ai-device-bulk-rename.md');
    expect(existsSync(result.artifacts.primary)).toBe(true);
    expect(existsSync(result.artifacts.rejected)).toBe(true);
    expect(existsSync(result.artifacts.notes)).toBe(true);
  });

  it('builds spaces contract and detects image input kind', () => {
    const root = makeTempRoot('xyte-ai-context-spaces-');
    const inputPath = join(root, 'tree.jpeg');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'placeholder', 'utf8');

    const result = buildUtilityAiContext({
      inputPath,
      entity: 'spaces',
      outputDir: outDir
    });

    expect(result.entity).toBe('spaces');
    expect(result.mappedAction).toBe('space.import-tree');
    expect(result.input.kind).toBe('image');
    expect(result.promptTemplatePath).toContain('ai-space-import.prompt.md');
    expect(result.skillNodePath).toContain('utility-ai-space-import-tree.md');
    expect(readFileSync(result.artifacts.primary, 'utf8')).toBe('');
    expect(readFileSync(result.artifacts.rejected, 'utf8')).toBe('');
  });

  it('creates deterministic scaffold contents', () => {
    const root = makeTempRoot('xyte-ai-context-contents-');
    const inputPath = join(root, 'source.csv');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'x', 'utf8');

    const result = buildUtilityAiContext({
      inputPath,
      entity: 'devices',
      outputDir: outDir
    });

    expect(readFileSync(result.artifacts.primary, 'utf8')).toBe('device_id,new_name\n');
    expect(readFileSync(result.artifacts.rejected, 'utf8')).toBe('device_id,new_name,reject_reason\n');
    expect(readFileSync(result.artifacts.notes, 'utf8')).toContain('# Bulk Rename Mapping Notes');
  });

  it('fails on scaffold collision unless force is set', () => {
    const root = makeTempRoot('xyte-ai-context-force-');
    const inputPath = join(root, 'source.csv');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, 'x', 'utf8');

    buildUtilityAiContext({
      inputPath,
      entity: 'devices',
      outputDir: outDir
    });

    expect(() =>
      buildUtilityAiContext({
        inputPath,
        entity: 'devices',
        outputDir: outDir
      })
    ).toThrow('--force');

    expect(() =>
      buildUtilityAiContext({
        inputPath,
        entity: 'devices',
        outputDir: outDir,
        force: true
      })
    ).not.toThrow();
  });

  it('emits output matching utility-ai-context schema', () => {
    const root = makeTempRoot('xyte-ai-context-schema-');
    const inputPath = join(root, 'source.md');
    const outDir = join(root, 'out');
    writeFileSync(inputPath, '# source', 'utf8');

    const schema = JSON.parse(
      readFileSync(join(process.cwd(), 'docs/schemas/utility-ai-context.v1.schema.json'), 'utf8')
    ) as Record<string, unknown>;
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);

    const result = buildUtilityAiContext({
      inputPath,
      entity: 'spaces',
      outputDir: outDir
    });

    expect(validate(result)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
