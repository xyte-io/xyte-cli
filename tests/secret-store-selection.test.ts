import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import {
  createSecretStore,
  describeSecretStore,
  MacKeychainSecretStore,
  WindowsDpapiSecretStore
} from '../src/secure/secret-store';

function writeSettings(
  filePath: string,
  data: {
    auth?: { secretStoreBackend?: 'auto' | 'native' | 'file' };
  }
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ version: 'settings.v1', ...data }, null, 2)}\n`, 'utf8');
}

function buildKeychainRunProcessMock(options: {
  available?: boolean;
  wrongReadback?: boolean;
} = {}) {
  const available = options.available ?? true;
  const wrongReadback = options.wrongReadback ?? false;
  const stored = new Map<string, string>();
  return vi.fn(async (_command: string, args: string[]) => {
    const subcommand = args[0];
    if (subcommand === 'default-keychain') {
      if (available) {
        return { code: 0, stdout: '/Users/test/Library/Keychains/login.keychain-db\n', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'security: SecKeychainCopyDefault: A default keychain could not be found.' };
    }
    if (subcommand === 'list-keychains') {
      if (available) {
        return { code: 0, stdout: '/Users/test/Library/Keychains/login.keychain-db\n', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'security: keychain unavailable' };
    }
    const service = args[args.indexOf('-s') + 1];
    const account = args[args.indexOf('-a') + 1];
    const key = `${service}:${account}`;
    if (subcommand === 'add-generic-password') {
      stored.set(key, args[args.indexOf('-w') + 1]);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (subcommand === 'find-generic-password') {
      if (!stored.has(key)) {
        return {
          code: 44,
          stdout: '',
          stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.'
        };
      }
      return { code: 0, stdout: wrongReadback ? 'wrong-value' : (stored.get(key) ?? ''), stderr: '' };
    }
    if (subcommand === 'delete-generic-password') {
      stored.delete(key);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: `unexpected security command: ${subcommand}` };
  });
}

function buildDpapiRunProcessMock(options: { available?: boolean; decryptFails?: boolean } = {}) {
  const available = options.available ?? true;
  const decryptFails = options.decryptFails ?? false;
  return vi.fn(async (_command: string, args: string[], runtimeOptions?: { input?: string; stdinMode?: 'pipe' | 'ignore' }) => {
    const script = args.join(' ');
    if (script.includes('Protect(') && script.includes('Unprotect(') && script.includes("[Console]::Out.Write('ok')")) {
      if (available) {
        return { code: 0, stdout: 'ok', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'DPAPI CurrentUser round-trip failed' };
    }
    if (script.includes('Protect(')) {
      const plaintext = runtimeOptions?.input ?? '';
      return {
        code: 0,
        stdout: Buffer.from(`cipher:${plaintext}`, 'utf8').toString('base64'),
        stderr: ''
      };
    }
    if (script.includes('Unprotect(')) {
      if (decryptFails) {
        return { code: 1, stdout: '', stderr: 'DPAPI decrypt failed' };
      }
      const payload = Buffer.from(runtimeOptions?.input ?? '', 'base64').toString('utf8');
      if (!payload.startsWith('cipher:')) {
        return { code: 1, stdout: '', stderr: 'invalid ciphertext' };
      }
      return { code: 0, stdout: payload.slice('cipher:'.length), stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unexpected PowerShell command' };
  });
}

describe('secret store backend selection', () => {
  it('prefers env override over workspace and user config', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'xyte-secret-store-cwd-'));
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-config-'));
    writeSettings(join(configDir, 'settings.json'), { auth: { secretStoreBackend: 'file' } });
    writeSettings(join(cwd, '.xyte', 'config.json'), { auth: { secretStoreBackend: 'native' } });
    const env = {
      ...process.env,
      XYTE_CLI_CONFIG_DIR: configDir,
      XYTE_CLI_SECRET_STORE_BACKEND: 'file'
    };

    const details = await describeSecretStore({
      cwd,
      env,
      platform: 'darwin',
      runProcessImpl: buildKeychainRunProcessMock()
    });

    expect(details.selector).toBe('file');
    expect(details.backend).toBe('file');
    expect(details.secretStore).toBe(join(configDir, 'secrets.v1.json'));
  });

  it('prefers workspace config over user config when env override is absent', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'xyte-secret-store-cwd-'));
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-config-'));
    writeSettings(join(configDir, 'settings.json'), { auth: { secretStoreBackend: 'file' } });
    writeSettings(join(cwd, '.xyte', 'config.json'), { auth: { secretStoreBackend: 'native' } });
    const env = { ...process.env, XYTE_CLI_CONFIG_DIR: configDir };

    const details = await describeSecretStore({
      cwd,
      env,
      platform: 'darwin',
      runProcessImpl: buildKeychainRunProcessMock()
    });

    expect(details.selector).toBe('native');
    expect(details.backend).toBe('keychain');
    expect(details.secretStore).toBe('xyte-cli');
  });

  it('maps auto to the native macOS backend', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-config-'));
    const details = await describeSecretStore({
      env: { ...process.env, XYTE_CLI_CONFIG_DIR: configDir },
      platform: 'darwin',
      runProcessImpl: buildKeychainRunProcessMock()
    });

    expect(details.selector).toBe('auto');
    expect(details.backend).toBe('keychain');
    expect(details.secretStore).toBe('xyte-cli');
    expect(details.legacySecretStore).toBe(join(configDir, 'secrets.v1.json'));
  });

  it('falls back to the file backend when auto is selected and the macOS default keychain is unavailable', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-config-'));
    const details = await describeSecretStore({
      env: { ...process.env, XYTE_CLI_CONFIG_DIR: configDir },
      platform: 'darwin',
      runProcessImpl: buildKeychainRunProcessMock({ available: false })
    });

    expect(details.selector).toBe('auto');
    expect(details.backend).toBe('file');
    expect(details.secretStore).toBe(join(configDir, 'secrets.v1.json'));
    expect(details.legacySecretStore).toBe(join(configDir, 'secrets.v1.json'));
  });

  it('maps auto to the native Windows backend', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-config-'));
    const details = await describeSecretStore({
      env: { ...process.env, XYTE_CLI_CONFIG_DIR: configDir },
      platform: 'win32',
      runProcessImpl: buildDpapiRunProcessMock()
    });

    expect(details.selector).toBe('auto');
    expect(details.backend).toBe('dpapi');
    expect(details.secretStore).toBe(join(configDir, 'secrets.dpapi.v1.json'));
  });

  it('falls back to the file backend when auto is selected and Windows DPAPI is unavailable', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-config-'));
    const details = await describeSecretStore({
      env: { ...process.env, XYTE_CLI_CONFIG_DIR: configDir },
      platform: 'win32',
      runProcessImpl: buildDpapiRunProcessMock({ available: false })
    });

    expect(details.selector).toBe('auto');
    expect(details.backend).toBe('file');
    expect(details.secretStore).toBe(join(configDir, 'secrets.v1.json'));
    expect(details.legacySecretStore).toBe(join(configDir, 'secrets.v1.json'));
  });

  it('maps auto to the file backend on Linux', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-config-'));
    const details = await describeSecretStore({
      env: { ...process.env, XYTE_CLI_CONFIG_DIR: configDir },
      platform: 'linux'
    });

    expect(details.selector).toBe('auto');
    expect(details.backend).toBe('file');
    expect(details.secretStore).toBe(join(configDir, 'secrets.v1.json'));
  });

  it('fails when native backend is requested on unsupported platforms', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-config-'));
    await expect(
      describeSecretStore({
        env: {
          ...process.env,
          XYTE_CLI_CONFIG_DIR: configDir,
          XYTE_CLI_SECRET_STORE_BACKEND: 'native'
        },
        platform: 'linux'
      })
    ).rejects.toThrow('Native secret storage is not supported');
  });

  it('fails when native backend is requested but unavailable', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-config-'));
    await expect(
      describeSecretStore({
        env: {
          ...process.env,
          XYTE_CLI_CONFIG_DIR: configDir,
          XYTE_CLI_SECRET_STORE_BACKEND: 'native'
        },
        platform: 'darwin',
        runProcessImpl: buildKeychainRunProcessMock({ available: false })
      })
    ).rejects.toThrow('Native secret storage is unavailable');
  });
});

describe('configured secret-store migration', () => {
  it('preserves the file backend when explicitly selected', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-file-'));
    const env = {
      ...process.env,
      XYTE_CLI_CONFIG_DIR: configDir,
      XYTE_CLI_SECRET_STORE_BACKEND: 'file'
    };
    const store = createSecretStore({ env, platform: 'darwin', runProcessImpl: buildKeychainRunProcessMock() });

    await store.setSlotSecret('acme', 'xyte-org', 'primary', 'org-key');
    expect(await store.getSlotSecret('acme', 'xyte-org', 'primary')).toBe('org-key');
    await store.clearSlotSecret('acme', 'xyte-org', 'primary');
    expect(await store.getSlotSecret('acme', 'xyte-org', 'primary')).toBeUndefined();

    const raw = JSON.parse(readFileSync(join(configDir, 'secrets.v1.json'), 'utf8')) as { records: Record<string, string> };
    expect(raw.records['acme:xyte-org:primary']).toBeUndefined();
  });

  it('migrates multiple legacy plaintext secrets into the macOS native backend and deletes the legacy file', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-migrate-'));
    const legacyPath = join(configDir, 'secrets.v1.json');
    writeFileSync(
      legacyPath,
      JSON.stringify(
        {
          version: 1,
          records: {
            'acme:xyte-org:primary': 'org-key',
            'acme:xyte-partner:partner-primary': 'partner-key',
            'globex:xyte-org:secondary': 'org-key-2'
          }
        },
        null,
        2
      ),
      'utf8'
    );
    const store = createSecretStore({
      env: { ...process.env, XYTE_CLI_CONFIG_DIR: configDir },
      platform: 'darwin',
      runProcessImpl: buildKeychainRunProcessMock()
    });

    expect(await store.getSlotSecret('acme', 'xyte-org', 'primary')).toBe('org-key');
    expect(await store.getSlotSecret('acme', 'xyte-partner', 'partner-primary')).toBe('partner-key');
    expect(await store.getSlotSecret('globex', 'xyte-org', 'secondary')).toBe('org-key-2');
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('migrates multiple legacy plaintext secrets into the Windows native backend and deletes the legacy file', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-migrate-'));
    const legacyPath = join(configDir, 'secrets.v1.json');
    writeFileSync(
      legacyPath,
      JSON.stringify(
        {
          version: 1,
          records: {
            'acme:xyte-org:primary': 'org-key',
            'acme:xyte-partner:partner-primary': 'partner-key',
            'globex:xyte-org:secondary': 'org-key-2'
          }
        },
        null,
        2
      ),
      'utf8'
    );
    const store = createSecretStore({
      env: { ...process.env, XYTE_CLI_CONFIG_DIR: configDir },
      platform: 'win32',
      runProcessImpl: buildDpapiRunProcessMock()
    });

    expect(await store.getSlotSecret('acme', 'xyte-org', 'primary')).toBe('org-key');
    expect(await store.getSlotSecret('acme', 'xyte-partner', 'partner-primary')).toBe('partner-key');
    expect(await store.getSlotSecret('globex', 'xyte-org', 'secondary')).toBe('org-key-2');
    expect(existsSync(legacyPath)).toBe(false);
  });

  it('keeps the legacy file and falls back to it under auto when migration verification fails', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-migrate-'));
    const legacyPath = join(configDir, 'secrets.v1.json');
    writeFileSync(
      legacyPath,
      JSON.stringify(
        {
          version: 1,
          records: {
            'acme:xyte-org:primary': 'org-key'
          }
        },
        null,
        2
      ),
      'utf8'
    );
    const stderr = { write: vi.fn() };
    const store = createSecretStore({
      env: { ...process.env, XYTE_CLI_CONFIG_DIR: configDir },
      platform: 'darwin',
      stderr,
      runProcessImpl: buildKeychainRunProcessMock({ wrongReadback: true })
    });

    expect(await store.getSlotSecret('acme', 'xyte-org', 'primary')).toBe('org-key');
    expect(existsSync(legacyPath)).toBe(true);
    expect(stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('Native secret-store migration failed, using legacy file secret store for this run.')
    );
  });

  it('fails under native when migration verification fails and leaves the legacy file untouched', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-migrate-'));
    const legacyPath = join(configDir, 'secrets.v1.json');
    writeFileSync(
      legacyPath,
      JSON.stringify(
        {
          version: 1,
          records: {
            'acme:xyte-org:primary': 'org-key'
          }
        },
        null,
        2
      ),
      'utf8'
    );
    const store = createSecretStore({
      env: {
        ...process.env,
        XYTE_CLI_CONFIG_DIR: configDir,
        XYTE_CLI_SECRET_STORE_BACKEND: 'native'
      },
      platform: 'darwin',
      runProcessImpl: buildKeychainRunProcessMock({ wrongReadback: true })
    });

    await expect(store.getSlotSecret('acme', 'xyte-org', 'primary')).rejects.toThrow(
      'Secret-store migration verification failed'
    );
    expect(existsSync(legacyPath)).toBe(true);
  });
});

describe('native secret-store backends', () => {
  it('uses the documented security command shape for macOS Keychain operations', async () => {
    const runProcessMock = buildKeychainRunProcessMock();
    const store = new MacKeychainSecretStore(runProcessMock);

    await store.setSlotSecret('acme', 'xyte-org', 'primary', 'org-key');
    await store.getSlotSecret('acme', 'xyte-org', 'primary');
    await store.clearSlotSecret('acme', 'xyte-org', 'primary');

    expect(runProcessMock.mock.calls[0]).toEqual(['security', ['add-generic-password', '-U', '-s', 'xyte-cli', '-a', 'acme:xyte-org:primary', '-w', 'org-key']]);
    expect(runProcessMock.mock.calls[1]).toEqual(['security', ['find-generic-password', '-s', 'xyte-cli', '-a', 'acme:xyte-org:primary', '-w']]);
    expect(runProcessMock.mock.calls[2]).toEqual(['security', ['delete-generic-password', '-s', 'xyte-cli', '-a', 'acme:xyte-org:primary']]);
  });

  it('stores Windows DPAPI ciphertext in a deterministic JSON file shape and round-trips secrets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xyte-secret-store-dpapi-'));
    const filePath = join(root, 'secrets.dpapi.v1.json');
    const store = new WindowsDpapiSecretStore(filePath, buildDpapiRunProcessMock());

    await store.setSlotSecret('acme', 'xyte-org', 'primary', 'org-key');
    expect(await store.getSlotSecret('acme', 'xyte-org', 'primary')).toBe('org-key');

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { version: number; records: Record<string, string> };
    expect(raw.version).toBe(1);
    expect(raw.records['acme:xyte-org:primary']).toBeDefined();
    expect(raw.records['acme:xyte-org:primary']).not.toBe('org-key');
  });

  it('raises a clear error for corrupted Windows DPAPI ciphertext', async () => {
    const root = mkdtempSync(join(tmpdir(), 'xyte-secret-store-dpapi-'));
    const filePath = join(root, 'secrets.dpapi.v1.json');
    writeFileSync(
      filePath,
      JSON.stringify(
        {
          version: 1,
          records: {
            'acme:xyte-org:primary': 'not-valid'
          }
        },
        null,
        2
      ),
      'utf8'
    );
    const store = new WindowsDpapiSecretStore(filePath, buildDpapiRunProcessMock({ decryptFails: true }));

    await expect(store.getSlotSecret('acme', 'xyte-org', 'primary')).rejects.toThrow(
      'Failed to decrypt secret from Windows DPAPI store'
    );
  });
});

describe('platform backend smoke tests', () => {
  it.runIf(process.platform === 'darwin')('runs a real macOS Keychain lifecycle and migration smoke test', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-macos-live-'));
    const tenantId = `macos-live-${Date.now()}`;
    const slotId = `slot-${Date.now()}`;
    const partnerSlotId = `partner-${Date.now()}`;
    const secondaryTenantId = `macos-live-secondary-${Date.now()}`;
    const secondarySlotId = `secondary-${Date.now()}`;
    const nativeStore = new MacKeychainSecretStore();
    const configured = createSecretStore({
      env: { ...process.env, XYTE_CLI_CONFIG_DIR: configDir },
      stderr: { write: vi.fn() }
    });
    const legacyPath = join(configDir, 'secrets.v1.json');
    writeFileSync(
      legacyPath,
      JSON.stringify(
        {
          version: 1,
          records: {
            [`${tenantId}:xyte-org:${slotId}`]: 'macos-live-key',
            [`${tenantId}:xyte-partner:${partnerSlotId}`]: 'macos-live-partner-key',
            [`${secondaryTenantId}:xyte-org:${secondarySlotId}`]: 'macos-live-key-3'
          }
        },
        null,
        2
      ),
      'utf8'
    );

    try {
      expect(await configured.getSlotSecret(tenantId, 'xyte-org', slotId)).toBe('macos-live-key');
      expect(await configured.getSlotSecret(tenantId, 'xyte-partner', partnerSlotId)).toBe('macos-live-partner-key');
      expect(await configured.getSlotSecret(secondaryTenantId, 'xyte-org', secondarySlotId)).toBe('macos-live-key-3');
      expect(existsSync(legacyPath)).toBe(false);
      await nativeStore.setSlotSecret(tenantId, 'xyte-org', slotId, 'macos-live-key-2');
      expect(await nativeStore.getSlotSecret(tenantId, 'xyte-org', slotId)).toBe('macos-live-key-2');
      expect(await nativeStore.getSlotSecret(tenantId, 'xyte-partner', partnerSlotId)).toBe('macos-live-partner-key');
      expect(await nativeStore.getSlotSecret(secondaryTenantId, 'xyte-org', secondarySlotId)).toBe('macos-live-key-3');
      await nativeStore.clearSlotSecret(tenantId, 'xyte-org', slotId);
      expect(await nativeStore.getSlotSecret(tenantId, 'xyte-org', slotId)).toBeUndefined();
    } finally {
      await nativeStore.clearSlotSecret(tenantId, 'xyte-org', slotId);
      await nativeStore.clearSlotSecret(tenantId, 'xyte-partner', partnerSlotId);
      await nativeStore.clearSlotSecret(secondaryTenantId, 'xyte-org', secondarySlotId);
    }
  });

  it.runIf(process.platform === 'linux')('keeps auto mapped to the file backend on Linux', async () => {
    const configDir = mkdtempSync(join(tmpdir(), 'xyte-secret-store-linux-live-'));
    const details = await describeSecretStore({
      env: { ...process.env, XYTE_CLI_CONFIG_DIR: configDir }
    });

    expect(details.backend).toBe('file');
    expect(details.secretStore).toBe(join(configDir, 'secrets.v1.json'));
  });
});
