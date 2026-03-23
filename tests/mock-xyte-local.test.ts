import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';

import { describe, expect, it } from 'vitest';

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve a free TCP port.')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function waitForServerReady(child: ReturnType<typeof spawn>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();

  return await new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      child.stdout?.off('data', onStdout);
      child.off('exit', onExit);
      clearInterval(timer);
    };

    const onStdout = (chunk: Buffer) => {
      if (String(chunk).includes('mock_xyte_local running')) {
        settled = true;
        cleanup();
        resolve();
      }
    };

    const onExit = () => {
      if (settled) {
        return;
      }
      cleanup();
      reject(new Error('Mock server exited before becoming ready.'));
    };

    const timer = setInterval(() => {
      if (Date.now() - start > timeoutMs) {
        cleanup();
        reject(new Error('Timed out waiting for mock server startup.'));
      }
    }, 100);

    child.stdout?.on('data', onStdout);
    child.on('exit', onExit);
  });
}

describe('local mock server', () => {
  it('supports canceling commands through the organization command routes', async () => {
    const port = await getFreePort();
    const child = spawn(
      process.execPath,
      ['scripts/mock_xyte_local.mjs', '--host', '127.0.0.1', '--port', String(port), '--strict-auth'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          XYTE_LOCAL_AUTH_TOKEN: 'local-key'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );

    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    await waitForServerReady(child);

    try {
      const headers = {
        authorization: 'Bearer local-key',
        'content-type': 'application/json'
      };

      const sendResponse = await fetch(`http://127.0.0.1:${port}/core/v1/organization/devices/d1/commands`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ command: 'reboot' })
      });
      expect(sendResponse.status).toBe(200);
      const sendPayload = (await sendResponse.json()) as { id: string };
      expect(sendPayload.id).toMatch(/^cmd-/);

      const cancelResponse = await fetch(
        `http://127.0.0.1:${port}/core/v1/organization/devices/d1/commands/${encodeURIComponent(sendPayload.id)}`,
        {
          method: 'DELETE',
          headers
        }
      );
      expect(cancelResponse.status).toBe(200);
      expect(await cancelResponse.json()).toMatchObject({
        ok: true,
        id: sendPayload.id,
        status: 'cancelled'
      });
    } finally {
      child.kill('SIGTERM');
      await once(child, 'exit').catch(() => undefined);
    }

    expect(stderr).toBe('');
  });
});
