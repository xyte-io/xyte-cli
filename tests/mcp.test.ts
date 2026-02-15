import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createMcpServer } from '../src/mcp/server';
import { MemoryKeychain } from '../src/secure/keychain';
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
    const keychain = new MemoryKeychain();
    const input = new PassThrough();
    const output = new PassThrough();
    const server = createMcpServer({ profileStore, keychain, input, output });
    const running = server.start();

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    const init = await waitForLine(output);
    expect(init.result.protocolVersion).toBe('2025-06-18');

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
    const listed = await waitForLine(output);
    expect(Array.isArray(listed.result.tools)).toBe(true);
    expect(listed.result.tools.some((tool: any) => tool.name === 'xyte_call')).toBe(true);

    input.end();
    await running;
  });
});
