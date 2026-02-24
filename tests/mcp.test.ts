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
  it('responds to initialize and utility tools', async () => {
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
    expect(listed.result.tools.some((tool: any) => tool.name === 'xyte_utility_prepare')).toBe(true);
    expect(listed.result.tools.some((tool: any) => tool.name === 'xyte_utility_list_actions')).toBe(true);
    expect(listed.result.tools.some((tool: any) => tool.name === 'xyte_space_import_tree')).toBe(true);
    expect(listed.result.tools.some((tool: any) => tool.name === 'xyte_device_bulk_rename')).toBe(false);
    expect(listed.result.tools.some((tool: any) => tool.name === 'xyte_utility_ai_context')).toBe(false);

    const tmpRoot = mkdtempSync(join(tmpdir(), 'xyte-mcp-utility-test-'));
    const inputPath = join(tmpRoot, 'source.csv');
    writeFileSync(inputPath, 'name,space_id,sn,mac,cloud_id\nCamera A,44,SN-1,,\n', 'utf8');

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'xyte_utility_prepare',
          arguments: {
            input_path: inputPath,
            action: 'organization.devices.claimDevice',
            output_dir: tmpRoot
          }
        }
      })}\n`
    );
    const prepareResult = await waitForLine(output);
    expect(prepareResult.result?.structuredContent?.schemaVersion).toBe('xyte.utility.prepare.v1');
    expect(prepareResult.result?.structuredContent?.actionKey).toBe('organization.devices.claimDevice');
    expect(existsSync(prepareResult.result?.structuredContent?.artifacts?.primary)).toBe(true);
    expect(existsSync(prepareResult.result?.structuredContent?.artifacts?.rejected)).toBe(true);
    expect(existsSync(prepareResult.result?.structuredContent?.artifacts?.notes)).toBe(true);

    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'xyte_utility_list_actions',
          arguments: {}
        }
      })}\n`
    );
    const actionsResult = await waitForLine(output);
    const actions = actionsResult.result?.structuredContent;
    expect(Array.isArray(actions)).toBe(true);
    expect(actions.some((item: any) => item.actionKey === 'organization.devices.claimDevice')).toBe(true);
    expect(actions.some((item: any) => item.actionKey === 'space.import-tree')).toBe(true);

    input.end();
    await running;
  });
});
