import { mkdtempSync, writeFileSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

async function loadSecretStoreModule() {
  const mod = await import('../src/secure/secret-store');
  return mod;
}

describe('secret store backends', () => {
  it('supports memory slot lifecycle', async () => {
    const { MemorySecretStore } = await loadSecretStoreModule();
    const store = new MemorySecretStore();

    await store.setSlotSecret('acme', 'xyte-org', 'primary', 'org-key');
    expect(await store.getSlotSecret('acme', 'xyte-org', 'primary')).toBe('org-key');

    await store.clearSlotSecret('acme', 'xyte-org', 'primary');
    expect(await store.getSlotSecret('acme', 'xyte-org', 'primary')).toBeUndefined();
  });

  it('persists slot records to a deterministic file format', async () => {
    const { FileSecretStore } = await loadSecretStoreModule();
    const root = mkdtempSync(join(tmpdir(), 'xyte-secret-store-'));
    const filePath = join(root, 'secrets.v1.json');
    const store = new FileSecretStore(filePath);

    await store.setSlotSecret('acme', 'xyte-org', 'primary', 'org-key');
    await store.setSlotSecret('acme', 'xyte-partner', 'primary', 'partner-key');

    const reloaded = new FileSecretStore(filePath);
    expect(await reloaded.getSlotSecret('acme', 'xyte-org', 'primary')).toBe('org-key');
    expect(await reloaded.getSlotSecret('acme', 'xyte-partner', 'primary')).toBe('partner-key');

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { version: number; records: Record<string, string> };
    expect(raw.version).toBe(1);
    expect(raw.records['acme:xyte-org:primary']).toBe('org-key');
    expect(raw.records['acme:xyte-partner:primary']).toBe('partner-key');

    if (process.platform !== 'win32') {
      const mode = (await stat(filePath)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('auto-purges unsupported provider secrets from persisted file', async () => {
    const { FileSecretStore } = await loadSecretStoreModule();
    const root = mkdtempSync(join(tmpdir(), 'xyte-secret-store-legacy-'));
    const filePath = join(root, 'secrets.v1.json');
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          version: 1,
          records: {
            'acme:xyte-org:primary': 'org-key',
            'acme:xyte-device:edge': 'device-key'
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const store = new FileSecretStore(filePath);
    expect(await store.getSlotSecret('acme', 'xyte-org', 'primary')).toBe('org-key');

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { version: number; records: Record<string, string> };
    expect(raw.records['acme:xyte-org:primary']).toBe('org-key');
    expect(raw.records['acme:xyte-device:edge']).toBeUndefined();
  });

  it('logs a warning when normalized migration cannot be persisted', async () => {
    const { FileSecretStore } = await loadSecretStoreModule();
    const root = mkdtempSync(join(tmpdir(), 'xyte-secret-store-migration-write-fail-'));
    const filePath = join(root, 'secrets.v1.json');
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          version: 1,
          records: {
            'acme:xyte-org:primary': 'org-key',
            'acme:xyte-device:edge': 'device-key'
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const writeError = new Error('read-only file system') as NodeJS.ErrnoException;
    writeError.code = 'EROFS';
    const writeFileSpy = vi.spyOn(nodeFs.promises, 'writeFile').mockRejectedValue(writeError);
    const loggerModule = await import('../src/observability/logger');
    const mockLogger = pino({ enabled: false });
    const warnSpy = vi.spyOn(mockLogger, 'warn').mockImplementation(() => {});
    const getLoggerSpy = vi.spyOn(loggerModule, 'getLogger').mockReturnValue(mockLogger);

    try {
      const store = new FileSecretStore(filePath);
      expect(await store.getSlotSecret('acme', 'xyte-org', 'primary')).toBe('org-key');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [obj] = warnSpy.mock.calls[0] ?? [];
      expect(String((obj as Record<string, unknown>).file)).toContain(filePath.split('/').pop());
    } finally {
      writeFileSpy.mockRestore();
      getLoggerSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('raises explicit error when persisted file is corrupt', async () => {
    const { FileSecretStore } = await loadSecretStoreModule();
    const root = mkdtempSync(join(tmpdir(), 'xyte-secret-store-corrupt-'));
    const filePath = join(root, 'secrets.v1.json');
    writeFileSync(filePath, '{not-valid-json', 'utf8');

    const store = new FileSecretStore(filePath);
    await expect(store.getSlotSecret('acme', 'xyte-org', 'primary')).rejects.toThrow('Secret store is invalid');
  });

  it('raises explicit permission error when store is unreadable', async () => {
    const readError = new Error('permission denied') as NodeJS.ErrnoException;
    readError.code = 'EACCES';
    const readFileSpy = vi.spyOn(nodeFs.promises, 'readFile').mockRejectedValue(readError);
    try {
      const { FileSecretStore } = await loadSecretStoreModule();
      const root = mkdtempSync(join(tmpdir(), 'xyte-secret-store-permission-'));
      const filePath = join(root, 'secrets.v1.json');
      const store = new FileSecretStore(filePath);

      await expect(store.getSlotSecret('acme', 'xyte-org', 'primary')).rejects.toThrow('Cannot read secret store at');

      expect(readFileSpy).toHaveBeenCalledTimes(1);
    } finally {
      readFileSpy.mockRestore();
    }
  });
});
