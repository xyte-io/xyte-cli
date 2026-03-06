import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Ajv2020 from 'ajv/dist/2020';
import { describe, expect, it, vi } from 'vitest';

import { loadInputRows } from '../src/utils/input-parser';
import { runSpaceImportTree } from '../src/workflows/utility-commands';
import type { XyteClient } from '../src/types/client';

function tempPath(filename: string): string {
  const root = mkdtempSync(join(tmpdir(), 'xyte-utility-test-'));
  return join(root, filename);
}

function writeFixture(filePath: string, content: string): string {
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('utility input parser', () => {
  it('parses csv rows', () => {
    const file = writeFixture(tempPath('rows.csv'), 'path,space_type\nHQ,site\nHQ/F1,floor\n');
    const parsed = loadInputRows(file, 'csv');
    expect(parsed.format).toBe('csv');
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toEqual({ path: 'HQ', space_type: 'site' });
  });

  it('parses json rows', () => {
    const file = writeFixture(tempPath('rows.json'), '[{"path":"HQ","space_type":"site"}]');
    const parsed = loadInputRows(file, 'json');
    expect(parsed.format).toBe('json');
    expect(parsed.rows[0]).toEqual({ path: 'HQ', space_type: 'site' });
  });

  it('parses jsonl rows', () => {
    const file = writeFixture(tempPath('rows.jsonl'), '{"path":"HQ"}\n{"path":"HQ/F1"}\n');
    const parsed = loadInputRows(file, 'jsonl');
    expect(parsed.format).toBe('jsonl');
    expect(parsed.rows).toHaveLength(2);
  });

  it('rejects non-object json rows', () => {
    const file = writeFixture(tempPath('rows.json'), '[1]');
    expect(() => loadInputRows(file, 'json')).toThrow('JSON row 1 must be an object.');
  });
});

describe('space import workflow', () => {
  it('runs import-tree as dry-run without endpoint calls', async () => {
    const inputPath = writeFixture(tempPath('space-import.csv'), 'path,space_type\nHQ,site\n');
    const client = {
      callWithMeta: vi.fn()
    } as unknown as XyteClient;

    const result = await runSpaceImportTree({
      client,
      tenantId: 'acme',
      inputPath,
      apply: false,
      continueOnError: false
    });

    expect(client.callWithMeta).not.toHaveBeenCalled();
    expect(result.mode).toBe('dry-run');
    expect(result.command).toBe('space.import-tree');
    expect(result.totals.rows).toBe(1);
    expect(result.totals.skipped).toBe(1);
  });

  it('parses config json and imports spaces', async () => {
    const inputPath = writeFixture(
      tempPath('space-import.csv'),
      'path,space_type,config\nHQ/Floor-1,building,"{""zone"":""north""}"\n'
    );

    const calls: Array<{ endpointKey: string; args: any }> = [];
    const client = {
      callWithMeta: vi.fn(async (endpointKey: string, args: any) => {
        calls.push({ endpointKey, args });
        if (endpointKey === 'organization.spaces.getSpaces') {
          if (args?.query?.space_type === 'root') {
            return {
              status: 200,
              durationMs: 1,
              retryCount: 0,
              data: { items: [{ id: 36047, name: 'Overview', parent_id: null, space_type: 'root' }], next_page: null },
              headers: {},
              attempts: 1
            };
          }
          return {
            status: 200,
            durationMs: 1,
            retryCount: 0,
            data: { items: [], next_page: null },
            headers: {},
            attempts: 1
          };
        }
        if (endpointKey === 'organization.spaces.findOrCreateSpace') {
          const id = args?.body?.name === 'HQ' ? 101 : 102;
          return {
            status: 200,
            durationMs: 1,
            retryCount: 0,
            data: { id, name: args?.body?.name, parent_id: args?.body?.parent_id },
            headers: {},
            attempts: 1
          };
        }
        throw new Error(`Unexpected endpoint ${endpointKey}`);
      })
    } as unknown as XyteClient;

    const reportPath = tempPath('report.ndjson');
    const result = await runSpaceImportTree({
      client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      continueOnError: false,
      reportPath
    });

    expect(result.reportPath).toContain('report.ndjson');
    expect(result.totals.succeeded).toBe(1);
    expect(result.totals.failed).toBe(0);
    const findOrCreateCalls = calls.filter((call) => call.endpointKey === 'organization.spaces.findOrCreateSpace');
    expect(findOrCreateCalls).toHaveLength(2);
    expect(findOrCreateCalls[0].args.body).toEqual({
      name: 'HQ',
      parent_id: 36047
    });
    expect(findOrCreateCalls[1].args.body).toEqual({
      name: 'Floor-1',
      parent_id: 101,
      space_type: 'building',
      config: { zone: 'north' }
    });
    const report = readFileSync(reportPath, 'utf8').trim().split('\n');
    expect(report.length).toBe(1);
  });

  it('fails apply when no root space can be resolved', async () => {
    const inputPath = writeFixture(tempPath('space-import.csv'), 'path,space_type\nHQ,site\n');
    const client = {
      callWithMeta: vi.fn(async (endpointKey: string) => {
        if (endpointKey === 'organization.spaces.getSpaces') {
          return {
            status: 200,
            durationMs: 1,
            retryCount: 0,
            data: { items: [], next_page: null },
            headers: {},
            attempts: 1
          };
        }
        throw new Error(`Unexpected endpoint ${endpointKey}`);
      })
    } as unknown as XyteClient;

    const result = await runSpaceImportTree({
      client,
      tenantId: 'acme',
      inputPath,
      apply: true,
      continueOnError: false
    });

    expect(result.totals.failed).toBe(1);
    expect(result.firstError?.message).toContain('Unable to resolve root space');
  });

  it('emits summary matching utility-batch schema', async () => {
    const schema = JSON.parse(
      readFileSync(join(process.cwd(), 'docs/schemas/utility-batch.v1.schema.json'), 'utf8')
    ) as Record<string, unknown>;
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(schema);

    const inputPath = writeFixture(tempPath('space-import.csv'), 'path,space_type\nHQ,site\n');
    const client = {
      callWithMeta: vi.fn()
    } as unknown as XyteClient;

    const result = await runSpaceImportTree({
      client,
      tenantId: 'acme',
      inputPath,
      apply: false,
      continueOnError: false
    });

    expect(validate(result)).toBe(true);
    expect(validate.errors).toBeNull();
  });
});
