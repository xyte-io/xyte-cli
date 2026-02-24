import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { createMcpServer } from '../src/mcp/server';
import { MemorySecretStore } from '../src/secure/secret-store';
import { MemoryProfileStore } from './support/memory-profile-store';

function waitForLine(stream: PassThrough): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for MCP response')), 3000);
    const onData = (chunk: Buffer) => {
      const line = chunk.toString('utf8').trim();
      if (!line) {
        return;
      }
      clearTimeout(timer);
      stream.off('data', onData);
      resolve(JSON.parse(line));
    };
    stream.on('data', onData);
  });
}

describe('mcp server', () => {
  it('responds to initialize and tools/list', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const input = new PassThrough();
    const output = new PassThrough();
    const server = createMcpServer({ profileStore, secretStore, input, output });
    const running = server.start();

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    const init = await waitForLine(output);
    expect(init.result.protocolVersion).toBe('2025-06-18');

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const listed = await waitForLine(output);
    expect(Array.isArray(listed.result.tools)).toBe(true);
    expect(listed.result.tools.some((tool: any) => tool.name === 'xyte_call')).toBe(true);
    expect(listed.result.tools.some((tool: any) => tool.name === 'xyte_device_bulk_rename')).toBe(true);
    expect(listed.result.tools.some((tool: any) => tool.name === 'xyte_space_import_tree')).toBe(true);
    expect(listed.result.tools.some((tool: any) => tool.name === 'xyte_utility_ai_context')).toBe(true);
    expect(listed.result.tools.some((tool: any) => tool.name === 'xyte_device_bulk_move')).toBe(false);

    const tmpRoot = mkdtempSync(join(tmpdir(), 'xyte-mcp-utility-test-'));
    const inputPath = join(tmpRoot, 'bulk-rename.csv');
    writeFileSync(inputPath, 'device_id,new_name\nd1,Camera A\n', 'utf8');

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'xyte_device_bulk_rename',
          arguments: {
            tenant: 'acme',
            input_path: inputPath
          }
        }
      })}\n`
    );
    const renameResult = await waitForLine(output);
    expect(renameResult.result?.structuredContent?.schemaVersion).toBe('xyte.utility.batch.v1');
    expect(renameResult.result?.structuredContent?.command).toBe('device.bulk-rename');
    expect(renameResult.result?.structuredContent?.mode).toBe('dry-run');

    const aiContextInputPath = join(tmpRoot, 'raw-source.pdf');
    const aiContextOutDir = join(tmpRoot, 'ai-context-out');
    writeFileSync(aiContextInputPath, 'placeholder', 'utf8');
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'xyte_utility_ai_context',
          arguments: {
            input_path: aiContextInputPath,
            entity: 'spaces',
            output_dir: aiContextOutDir
          }
        }
      })}\n`
    );
    const aiContextResult = await waitForLine(output);
    expect(aiContextResult.result?.structuredContent?.schemaVersion).toBe('xyte.utility.ai-context.v1');
    expect(aiContextResult.result?.structuredContent?.entity).toBe('spaces');
    expect(aiContextResult.result?.structuredContent?.skillNodePath).toContain('utility-ai-space-import-tree.md');
    expect(existsSync(aiContextResult.result?.structuredContent?.artifacts?.primary)).toBe(true);
    expect(existsSync(aiContextResult.result?.structuredContent?.artifacts?.rejected)).toBe(true);
    expect(existsSync(aiContextResult.result?.structuredContent?.artifacts?.notes)).toBe(true);

    input.end();
    await running;
  });
});
