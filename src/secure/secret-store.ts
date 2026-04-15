import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ResolvedCliSettingsState } from '../config/settings';
import { resolveCliSettingsSync } from '../config/settings';
import { CliUserError } from '../contracts/user-error';
import { getLogger } from '../observability/logger';
import type { SecretProvider } from '../types/profile';
import { isSecretProvider } from '../types/profile';
import type { SecretStoreBackendSelector } from '../types/settings-enums';
import type { SecretStore } from '../types/stores';
import { getXyteConfigDir } from '../utils/config-dir';
import { errorMessage } from '../utils/error-format';
import { runProcess } from '../utils/run-command';
import { DEFAULT_SLOT_ID } from './key-slots';

const LEGACY_SECRET_STORE_VERSION = 1;
const DPAPI_SECRET_STORE_VERSION = 1;
const KEYCHAIN_SERVICE_NAME = 'xyte-cli';
const LEGACY_SECRET_STORE_FILENAME = 'secrets.v1.json';
const DPAPI_SECRET_STORE_FILENAME = 'secrets.dpapi.v1.json';

interface PersistedSecrets {
  version: number;
  records: Record<string, string>;
}

interface PersistedCiphertexts {
  version: number;
  records: Record<string, string>;
}

type EffectiveSecretStoreBackend = 'file' | 'keychain' | 'dpapi';

interface NativeSecretStore extends SecretStore {
  checkAvailability(): Promise<{ available: boolean; reason?: string }>;
  readonly backend: Exclude<EffectiveSecretStoreBackend, 'file'>;
  readonly location: string;
}

interface CreateSecretStoreOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  settings?: ResolvedCliSettingsState;
  stderr?: Pick<typeof process.stderr, 'write'>;
  runProcessImpl?: typeof runProcess;
}

export interface SecretStoreDiagnostics {
  selector: SecretStoreBackendSelector;
  backend: EffectiveSecretStoreBackend;
  secretStore: string;
  legacySecretStore: string;
}

const EMPTY_SECRETS: PersistedSecrets = {
  version: LEGACY_SECRET_STORE_VERSION,
  records: {}
};

const EMPTY_CIPHERTEXTS: PersistedCiphertexts = {
  version: DPAPI_SECRET_STORE_VERSION,
  records: {}
};

export type { SecretStore } from '../types/stores';

function accountKey(tenantId: string, provider: SecretProvider, slotId: string): string {
  return `${tenantId}:${provider}:${slotId}`;
}

function parseAccountKey(value: string): { tenantId: string; provider: SecretProvider; slotId: string } | undefined {
  const firstSeparator = value.indexOf(':');
  const secondSeparator = value.indexOf(':', firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1 || secondSeparator >= value.length - 1) {
    return undefined;
  }
  const provider = value.slice(firstSeparator + 1, secondSeparator);
  if (!isSecretProvider(provider)) {
    return undefined;
  }
  return {
    tenantId: value.slice(0, firstSeparator),
    provider,
    slotId: value.slice(secondSeparator + 1)
  };
}

function cloneRecordFile<T extends PersistedSecrets | PersistedCiphertexts>(data: T): T {
  return {
    version: data.version,
    records: { ...(data.records ?? {}) }
  } as T;
}

function sanitizeRecords(records: Record<string, string>): { records: Record<string, string>; changed: boolean } {
  const sanitized: Record<string, string> = {};
  let changed = false;
  for (const [storedKey, value] of Object.entries(records)) {
    if (typeof value !== 'string') {
      changed = true;
      continue;
    }
    if (!parseAccountKey(storedKey)) {
      changed = true;
      continue;
    }
    sanitized[storedKey] = value;
  }
  if (Object.keys(records).length !== Object.keys(sanitized).length) {
    changed = true;
  }
  return { records: sanitized, changed };
}

function getLegacySecretStorePath(configDir: string): string {
  return path.join(configDir, LEGACY_SECRET_STORE_FILENAME);
}

function getDpapiSecretStorePath(configDir: string): string {
  return path.join(configDir, DPAPI_SECRET_STORE_FILENAME);
}

function resolveSettingsState(options: CreateSecretStoreOptions): ResolvedCliSettingsState {
  return (
    options.settings ??
    resolveCliSettingsSync({
      cwd: options.cwd,
      env: options.env
    })
  );
}

function resolveBackendSelector(options: CreateSecretStoreOptions): SecretStoreBackendSelector {
  return resolveSettingsState(options).values.auth.secretStoreBackend;
}

function warnSecretStore(message: string, options: CreateSecretStoreOptions): void {
  const stream = options.stderr ?? process.stderr;
  stream.write(`${message}\n`);
}

function isMacKeychainUnavailable(stderr: string): boolean {
  const normalized = stderr.trim().toLowerCase();
  return (
    normalized.includes('could not be found') ||
    normalized.includes('the specified item could not be found') ||
    normalized.includes('could not be found in the keychain') ||
    normalized.includes('errsecitemnotfound') ||
    normalized.includes('exit code 44')
  );
}

async function readJsonRecordFile<T extends PersistedSecrets | PersistedCiphertexts>(
  filePath: string,
  emptyValue: T,
  labels: { summary: string; read: string }
): Promise<T> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    const maybeErrno = error as NodeJS.ErrnoException;
    if (maybeErrno.code === 'ENOENT') {
      return cloneRecordFile(emptyValue);
    }
    if (
      maybeErrno.code === 'EACCES' ||
      maybeErrno.code === 'EPERM' ||
      maybeErrno.code === 'EROFS' ||
      maybeErrno.code === 'ENOTDIR'
      ) {
        throw new CliUserError({
          summary: `Cannot read ${labels.read} at ${filePath}. Check file permissions or directory access (error=${maybeErrno.code}).`
        });
      }
      if (maybeErrno instanceof Error) {
        throw new CliUserError({ summary: `Failed to read ${labels.read} at ${filePath}: ${maybeErrno.message}` });
      }
      throw new CliUserError({ summary: `Failed to read ${labels.read} at ${filePath}.` });
    }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
    } catch (error) {
      const detail = errorMessage(error);
      throw new CliUserError({
        summary: `${labels.summary} is invalid at ${filePath}: ${detail}. Delete or fix this file and rerun setup.`
      });
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CliUserError({
        summary: `${labels.summary} is invalid at ${filePath}. Delete or fix this file and rerun setup.`
      });
    }
    const asRecord = parsed as PersistedSecrets;
    if (!asRecord.records || typeof asRecord.records !== 'object' || Array.isArray(asRecord.records)) {
      throw new CliUserError({
        summary: `${labels.summary} is invalid at ${filePath}. Delete or fix this file and rerun setup.`
      });
    }
  return cloneRecordFile({
    version: typeof asRecord.version === 'number' ? asRecord.version : emptyValue.version,
    records: asRecord.records
  } as T);
}

async function writeJsonRecordFile<T extends PersistedSecrets | PersistedCiphertexts>(
  filePath: string,
  data: T,
  version: number
): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const normalized = cloneRecordFile({
    version,
    records: data.records
  } as T);
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  if (process.platform !== 'win32') {
    await fs.chmod(tmpPath, 0o600);
  }
  await fs.rename(tmpPath, filePath);
  if (process.platform !== 'win32') {
    await fs.chmod(filePath, 0o600);
  }
}

async function deleteFileIfExists(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function legacyFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readLegacyRecordFile(filePath: string): Promise<PersistedSecrets> {
  const raw = await readJsonRecordFile(filePath, EMPTY_SECRETS, {
    summary: 'Secret store',
    read: 'secret store'
  });
  const sanitized = sanitizeRecords(raw.records);
  const normalized = cloneRecordFile({
    version: raw.version === LEGACY_SECRET_STORE_VERSION ? raw.version : LEGACY_SECRET_STORE_VERSION,
    records: sanitized.records
  });
  const changed = raw.version !== LEGACY_SECRET_STORE_VERSION || sanitized.changed;
  if (changed) {
    try {
      await writeJsonRecordFile(filePath, normalized, LEGACY_SECRET_STORE_VERSION);
    } catch (writeError) {
      getLogger().warn(
        { file: filePath, errorMessage: errorMessage(writeError) },
        'Failed to persist normalized secret data'
      );
    }
  }
  return normalized;
}

async function readDpapiRecordFile(filePath: string): Promise<PersistedCiphertexts> {
  const raw = await readJsonRecordFile(filePath, EMPTY_CIPHERTEXTS, {
    summary: 'DPAPI secret store',
    read: 'DPAPI secret store'
  });
  const sanitized = sanitizeRecords(raw.records);
  const normalized = cloneRecordFile({
    version: raw.version === DPAPI_SECRET_STORE_VERSION ? raw.version : DPAPI_SECRET_STORE_VERSION,
    records: sanitized.records
  });
  const changed = raw.version !== DPAPI_SECRET_STORE_VERSION || sanitized.changed;
  if (changed) {
    await writeJsonRecordFile(filePath, normalized, DPAPI_SECRET_STORE_VERSION);
  }
  return normalized;
}

export class FileSecretStore implements SecretStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? getLegacySecretStorePath(getXyteConfigDir());
  }

  async setSlotSecret(tenantId: string, provider: SecretProvider, slotId: string, value: string): Promise<void> {
    const data = await readLegacyRecordFile(this.filePath);
    data.records[accountKey(tenantId, provider, slotId)] = value;
    await writeJsonRecordFile(this.filePath, data, LEGACY_SECRET_STORE_VERSION);
  }

  async getSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<string | undefined> {
    const data = await readLegacyRecordFile(this.filePath);
    const value = data.records[accountKey(tenantId, provider, slotId)];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  async clearSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<void> {
    const data = await readLegacyRecordFile(this.filePath);
    delete data.records[accountKey(tenantId, provider, slotId)];
    await writeJsonRecordFile(this.filePath, data, LEGACY_SECRET_STORE_VERSION);
  }
}

export class MemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  async setSlotSecret(tenantId: string, provider: SecretProvider, slotId: string, value: string): Promise<void> {
    this.values.set(accountKey(tenantId, provider, slotId), value);
  }

  async getSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<string | undefined> {
    return this.values.get(accountKey(tenantId, provider, slotId));
  }

  async clearSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<void> {
    this.values.delete(accountKey(tenantId, provider, slotId));
  }

  async setSecret(tenantId: string, provider: SecretProvider, value: string): Promise<void> {
    await this.setSlotSecret(tenantId, provider, DEFAULT_SLOT_ID, value);
  }

  async getSecret(tenantId: string, provider: SecretProvider): Promise<string | undefined> {
    return await this.getSlotSecret(tenantId, provider, DEFAULT_SLOT_ID);
  }

  async clearSecret(tenantId: string, provider: SecretProvider): Promise<void> {
    await this.clearSlotSecret(tenantId, provider, DEFAULT_SLOT_ID);
  }
}

export class MacKeychainSecretStore implements NativeSecretStore {
  readonly backend = 'keychain' as const;
  readonly location = KEYCHAIN_SERVICE_NAME;

  constructor(private readonly runProcessImpl: typeof runProcess = runProcess) {}

  async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
    const result = await this.runProcessImpl('security', ['default-keychain'], { stdinMode: 'ignore' });
    if (result.code === 0 && result.stdout.trim()) {
      return { available: true };
    }
    return {
      available: false,
      reason: result.stderr.trim() || result.stdout.trim() || 'macOS Keychain is unavailable.'
    };
  }

  async setSlotSecret(tenantId: string, provider: SecretProvider, slotId: string, value: string): Promise<void> {
    const result = await this.runProcessImpl('security', [
      'add-generic-password',
      '-U',
      '-s',
      KEYCHAIN_SERVICE_NAME,
      '-a',
      accountKey(tenantId, provider, slotId),
      '-w',
      value
    ]);
    if (result.code !== 0) {
      throw new CliUserError({
        summary: 'Failed to write secret to macOS Keychain.',
        detail: result.stderr.trim() || result.stdout.trim() || 'security add-generic-password failed.'
      });
    }
  }

  async getSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<string | undefined> {
    const result = await this.runProcessImpl('security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE_NAME,
      '-a',
      accountKey(tenantId, provider, slotId),
      '-w'
    ]);
    if (result.code === 0) {
      const value = result.stdout.replace(/\r?\n$/, '');
      return value || undefined;
    }
    if (isMacKeychainUnavailable(result.stderr)) {
      return undefined;
    }
    throw new CliUserError({
      summary: 'Failed to read secret from macOS Keychain.',
      detail: result.stderr.trim() || result.stdout.trim() || 'security find-generic-password failed.'
    });
  }

  async clearSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<void> {
    const result = await this.runProcessImpl('security', [
      'delete-generic-password',
      '-s',
      KEYCHAIN_SERVICE_NAME,
      '-a',
      accountKey(tenantId, provider, slotId)
    ]);
    if (result.code === 0 || isMacKeychainUnavailable(result.stderr)) {
      return;
    }
    throw new CliUserError({
      summary: 'Failed to delete secret from macOS Keychain.',
      detail: result.stderr.trim() || result.stdout.trim() || 'security delete-generic-password failed.'
    });
  }
}

export class WindowsDpapiSecretStore implements NativeSecretStore {
  readonly backend = 'dpapi' as const;
  readonly location: string;

  constructor(
    private readonly filePath: string,
    private readonly runProcessImpl: typeof runProcess = runProcess
  ) {
    this.location = filePath;
  }

  async checkAvailability(): Promise<{ available: boolean; reason?: string }> {
    const probe = `xyte-cli-dpapi-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const result = await this.runPowerShell(
      [
        '$inputValue = [Console]::In.ReadToEnd();',
        '$bytes = [System.Text.Encoding]::UTF8.GetBytes($inputValue);',
        '$protected = [System.Security.Cryptography.ProtectedData]::Protect(',
        '  $bytes,',
        '  $null,',
        '  [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
        ');',
        '$roundTripBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(',
        '  $protected,',
        '  $null,',
        '  [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
        ');',
        '$roundTrip = [System.Text.Encoding]::UTF8.GetString($roundTripBytes);',
        'if ($roundTrip -ne $inputValue) {',
        "  throw 'Windows DPAPI CurrentUser round-trip mismatch.'",
        '}',
        "[Console]::Out.Write('ok');"
      ].join(' '),
      probe
    );
    if (result.code === 0 && result.stdout.trim() === 'ok') {
      return { available: true };
    }
    return {
      available: false,
      reason: result.stderr.trim() || result.stdout.trim() || 'Windows DPAPI is unavailable.'
    };
  }

  async setSlotSecret(tenantId: string, provider: SecretProvider, slotId: string, value: string): Promise<void> {
    const data = await readDpapiRecordFile(this.filePath);
    data.records[accountKey(tenantId, provider, slotId)] = await this.encrypt(value);
    await writeJsonRecordFile(this.filePath, data, DPAPI_SECRET_STORE_VERSION);
  }

  async getSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<string | undefined> {
    const data = await readDpapiRecordFile(this.filePath);
    const ciphertext = data.records[accountKey(tenantId, provider, slotId)];
    if (!ciphertext) {
      return undefined;
    }
    return await this.decrypt(ciphertext);
  }

  async clearSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<void> {
    const data = await readDpapiRecordFile(this.filePath);
    delete data.records[accountKey(tenantId, provider, slotId)];
    await writeJsonRecordFile(this.filePath, data, DPAPI_SECRET_STORE_VERSION);
  }

  private async encrypt(value: string): Promise<string> {
    const result = await this.runPowerShell(
      [
        '$inputValue = [Console]::In.ReadToEnd();',
        '$bytes = [System.Text.Encoding]::UTF8.GetBytes($inputValue);',
        '$protected = [System.Security.Cryptography.ProtectedData]::Protect(',
        '  $bytes,',
        '  $null,',
        '  [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
        ');',
        '[Console]::Out.Write([Convert]::ToBase64String($protected));'
      ].join(' '),
      value
    );
    if (result.code !== 0) {
      throw new CliUserError({
        summary: 'Failed to encrypt secret with Windows DPAPI.',
        detail: result.stderr.trim() || result.stdout.trim() || 'PowerShell DPAPI protect failed.'
      });
    }
    const ciphertext = result.stdout.trim();
    if (!ciphertext) {
      throw new CliUserError({ summary: 'Failed to encrypt secret with Windows DPAPI. Empty ciphertext returned.' });
    }
    return ciphertext;
  }

  private async decrypt(ciphertext: string): Promise<string> {
    const result = await this.runPowerShell(
      [
        '$inputValue = [Console]::In.ReadToEnd();',
        '$protected = [Convert]::FromBase64String($inputValue);',
        '$bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(',
        '  $protected,',
        '  $null,',
        '  [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
        ');',
        '[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($bytes));'
      ].join(' '),
      ciphertext
    );
    if (result.code !== 0) {
      throw new CliUserError({
        summary: 'Failed to decrypt secret from Windows DPAPI store.',
        detail: result.stderr.trim() || result.stdout.trim() || 'PowerShell DPAPI unprotect failed.'
      });
    }
    return result.stdout;
  }

  private async runPowerShell(
    script: string,
    input?: string,
    stdinMode: 'pipe' | 'ignore' = 'pipe'
  ): Promise<Awaited<ReturnType<typeof runProcess>>> {
    return await this.runProcessImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        input,
        stdinMode
      }
    );
  }
}

interface SecretStoreSelection {
  selector: SecretStoreBackendSelector;
  backend: EffectiveSecretStoreBackend;
  secretStore: SecretStore;
  legacySecretStorePath: string;
  location: string;
  autoFallbackReason?: string;
}

async function migrateLegacySecretFile(args: {
  legacySecretStorePath: string;
  targetSecretStore: NativeSecretStore;
}): Promise<{ migrated: boolean }> {
  if (!(await legacyFileExists(args.legacySecretStorePath))) {
    return { migrated: false };
  }
  const legacy = await readLegacyRecordFile(args.legacySecretStorePath);
  for (const [storedKey, value] of Object.entries(legacy.records)) {
    const parsed = parseAccountKey(storedKey);
    if (!parsed) {
      continue;
    }
    await args.targetSecretStore.setSlotSecret(parsed.tenantId, parsed.provider, parsed.slotId, value);
  }
  for (const [storedKey, value] of Object.entries(legacy.records)) {
    const parsed = parseAccountKey(storedKey);
    if (!parsed) {
      continue;
    }
    const actual = await args.targetSecretStore.getSlotSecret(parsed.tenantId, parsed.provider, parsed.slotId);
    if (actual !== value) {
      throw new CliUserError({
        summary: 'Secret-store migration verification failed.',
        detail: `Imported secret for ${storedKey} did not round-trip from the native secret store.`
      });
    }
  }
  await deleteFileIfExists(args.legacySecretStorePath);
  return { migrated: true };
}

function createNativeSecretStore(options: CreateSecretStoreOptions): NativeSecretStore | undefined {
  const configDir = resolveSettingsState(options).paths.configDir;
  const runProcessImpl = options.runProcessImpl ?? runProcess;
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    return new MacKeychainSecretStore(runProcessImpl);
  }
  if (platform === 'win32') {
    return new WindowsDpapiSecretStore(getDpapiSecretStorePath(configDir), runProcessImpl);
  }
  return undefined;
}

async function resolveSecretStoreBackendTarget(options: CreateSecretStoreOptions): Promise<SecretStoreSelection> {
  const settings = resolveSettingsState(options);
  const selector = resolveBackendSelector({ ...options, settings });
  const legacySecretStorePath = getLegacySecretStorePath(settings.paths.configDir);
  const fileSecretStore = new FileSecretStore(legacySecretStorePath);
  const nativeSecretStore = createNativeSecretStore({ ...options, settings });

  if (selector === 'file') {
    return {
      selector,
      backend: 'file',
      secretStore: fileSecretStore,
      legacySecretStorePath,
      location: legacySecretStorePath
    };
  }

  if (!nativeSecretStore) {
    if (selector === 'native') {
      throw new CliUserError({
        summary: `Native secret storage is not supported on ${options.platform ?? process.platform}.`,
        detail: 'Use auth.secretStoreBackend=file on unsupported platforms.'
      });
    }
    return {
      selector,
      backend: 'file',
      secretStore: fileSecretStore,
      legacySecretStorePath,
      location: legacySecretStorePath
    };
  }

  const availability = await nativeSecretStore.checkAvailability();
  if (!availability.available) {
    if (selector === 'native') {
      throw new CliUserError({
        summary: `Native secret storage is unavailable on ${options.platform ?? process.platform}.`,
        detail: availability.reason
      });
    }
    return {
      selector,
      backend: 'file',
      secretStore: fileSecretStore,
      legacySecretStorePath,
      location: legacySecretStorePath,
      autoFallbackReason: availability.reason
    };
  }

  return {
    selector,
    backend: nativeSecretStore.backend,
    secretStore: nativeSecretStore,
    legacySecretStorePath,
    location: nativeSecretStore.location
  };
}

async function resolveSecretStoreSelection(options: CreateSecretStoreOptions): Promise<SecretStoreSelection> {
  const selection = await resolveSecretStoreBackendTarget(options);
  if (selection.autoFallbackReason) {
    warnSecretStore(
      `Warning: Native secret storage is unavailable, using legacy file secret store instead. ${selection.autoFallbackReason}`.trim(),
      options
    );
    return selection;
  }
  if (selection.backend === 'file') {
    return selection;
  }
  try {
    await migrateLegacySecretFile({
      legacySecretStorePath: selection.legacySecretStorePath,
      targetSecretStore: selection.secretStore as NativeSecretStore
    });
    return selection;
  } catch (error) {
    if (selection.selector === 'native') {
      throw error;
    }
    warnSecretStore(
      `Warning: Native secret-store migration failed, using legacy file secret store for this run. ${errorMessage(error)}`.trim(),
      options
    );
    return {
      selector: selection.selector,
      backend: 'file',
      secretStore: new FileSecretStore(selection.legacySecretStorePath),
      legacySecretStorePath: selection.legacySecretStorePath,
      location: selection.legacySecretStorePath
    };
  }
}

class ConfiguredSecretStore implements SecretStore {
  private selectionPromise: Promise<SecretStoreSelection> | undefined;

  constructor(private readonly options: CreateSecretStoreOptions = {}) {}

  async setSlotSecret(tenantId: string, provider: SecretProvider, slotId: string, value: string): Promise<void> {
    const secretStore = await this.getSelectedStore();
    await secretStore.setSlotSecret(tenantId, provider, slotId, value);
  }

  async getSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<string | undefined> {
    const secretStore = await this.getSelectedStore();
    return await secretStore.getSlotSecret(tenantId, provider, slotId);
  }

  async clearSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<void> {
    const secretStore = await this.getSelectedStore();
    await secretStore.clearSlotSecret(tenantId, provider, slotId);
  }

  private async getSelectedStore(): Promise<SecretStore> {
    if (!this.selectionPromise) {
      this.selectionPromise = resolveSecretStoreSelection(this.options);
    }
    return (await this.selectionPromise).secretStore;
  }
}

export async function describeSecretStore(options: CreateSecretStoreOptions = {}): Promise<SecretStoreDiagnostics> {
  const selection = await resolveSecretStoreBackendTarget(options);
  return {
    selector: selection.selector,
    backend: selection.backend,
    secretStore: selection.location,
    legacySecretStore: selection.legacySecretStorePath
  };
}

export function createSecretStore(options: CreateSecretStoreOptions = {}): SecretStore {
  return new ConfiguredSecretStore(options);
}
