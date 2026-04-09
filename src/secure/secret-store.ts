import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SecretProvider } from '../types/profile';
import { isSecretProvider } from '../types/profile';
import { getXyteConfigDir } from '../utils/config-dir';
import { errorMessage } from '../utils/error-format';
import { getLogger } from '../observability/logger';
import { DEFAULT_SLOT_ID } from './key-slots';

const SECRET_STORE_VERSION = 1;

interface PersistedSecrets {
  version: number;
  records: Record<string, string>;
}

const EMPTY_SECRETS: PersistedSecrets = {
  version: SECRET_STORE_VERSION,
  records: {}
};

export interface SecretStore {
  setSecret(tenantId: string, provider: SecretProvider, value: string): Promise<void>;
  getSecret(tenantId: string, provider: SecretProvider): Promise<string | undefined>;
  clearSecret(tenantId: string, provider: SecretProvider): Promise<void>;
  setSlotSecret(tenantId: string, provider: SecretProvider, slotId: string, value: string): Promise<void>;
  getSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<string | undefined>;
  clearSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<void>;
}

function accountKey(tenantId: string, provider: SecretProvider, slotId: string): string {
  return `${tenantId}:${provider}:${slotId}`;
}

function cloneData(data: PersistedSecrets): PersistedSecrets {
  return {
    version: SECRET_STORE_VERSION,
    records: { ...(data.records ?? {}) }
  };
}

function parseAccountKey(value: string): { tenantId: string; provider: string; slotId: string } | undefined {
  const firstSeparator = value.indexOf(':');
  const secondSeparator = value.indexOf(':', firstSeparator + 1);
  if (firstSeparator <= 0 || secondSeparator <= firstSeparator + 1 || secondSeparator >= value.length - 1) {
    return undefined;
  }
  return {
    tenantId: value.slice(0, firstSeparator),
    provider: value.slice(firstSeparator + 1, secondSeparator),
    slotId: value.slice(secondSeparator + 1)
  };
}

function sanitizeRecords(records: Record<string, string>): { records: Record<string, string>; changed: boolean } {
  const sanitized: Record<string, string> = {};
  let changed = false;

  for (const [account, secret] of Object.entries(records)) {
    if (typeof secret !== 'string') {
      changed = true;
      continue;
    }

    const parsed = parseAccountKey(account);
    if (!parsed || !isSecretProvider(parsed.provider)) {
      changed = true;
      continue;
    }

    sanitized[account] = secret;
  }

  const originalCount = Object.keys(records).length;
  const sanitizedCount = Object.keys(sanitized).length;
  if (originalCount !== sanitizedCount) {
    changed = true;
  }

  return {
    records: sanitized,
    changed
  };
}

export class FileSecretStore implements SecretStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? path.join(getXyteConfigDir(), 'secrets.v1.json');
  }

  async setSlotSecret(tenantId: string, provider: SecretProvider, slotId: string, value: string): Promise<void> {
    const data = await this.readData();
    data.records[accountKey(tenantId, provider, slotId)] = value;
    await this.writeData(data);
  }

  async getSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<string | undefined> {
    const data = await this.readData();
    const value = data.records[accountKey(tenantId, provider, slotId)];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  async clearSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<void> {
    const data = await this.readData();
    delete data.records[accountKey(tenantId, provider, slotId)];
    await this.writeData(data);
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

  private async readData(): Promise<PersistedSecrets> {
    let content: string;
    try {
      content = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      const maybeErrno = error as NodeJS.ErrnoException;
      if (maybeErrno.code === 'ENOENT') {
        return cloneData(EMPTY_SECRETS);
      }
      if (
        maybeErrno.code === 'EACCES' ||
        maybeErrno.code === 'EPERM' ||
        maybeErrno.code === 'EROFS' ||
        maybeErrno.code === 'ENOTDIR'
      ) {
        throw new Error(
          `Cannot read secret store at ${this.filePath}. Check file permissions or directory access (error=${maybeErrno.code}).`
        );
      }
      if (maybeErrno instanceof Error) {
        throw new Error(`Failed to read secret store at ${this.filePath}: ${maybeErrno.message}`);
      }
      throw new Error(`Failed to read secret store at ${this.filePath}.`);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content) as PersistedSecrets;
    } catch (error) {
      const detail = errorMessage(error);
      throw new Error(
        `Secret store is invalid at ${this.filePath}: ${detail}. Delete or fix this file and rerun setup.`
      );
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Secret store is invalid at ${this.filePath}. Delete or fix this file and rerun setup.`);
    }

    const asRecord = parsed as PersistedSecrets;
    if (!asRecord.records || typeof asRecord.records !== 'object' || Array.isArray(asRecord.records)) {
      throw new Error(`Secret store is invalid at ${this.filePath}. Delete or fix this file and rerun setup.`);
    }

    const normalized = cloneData({
      version: asRecord.version === SECRET_STORE_VERSION ? asRecord.version : SECRET_STORE_VERSION,
      records: asRecord.records
    });
    const sanitized = sanitizeRecords(normalized.records);
    normalized.records = sanitized.records;
    const changed = sanitized.changed || asRecord.version !== SECRET_STORE_VERSION;
    if (changed) {
      try {
        await this.writeData(normalized);
      } catch (writeError) {
        // Best-effort migration: continue returning normalized data even if we cannot write.
        // This avoids breaking reads when the secrets file is readable but not writable (e.g. read-only filesystem).
         
        getLogger().warn({ file: this.filePath, errorMessage: errorMessage(writeError) }, 'Failed to persist normalized secret data');
      }
    }
    return normalized;
  }

  private async writeData(data: PersistedSecrets): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    const normalized = cloneData(data);

    const tmpPath = `${this.filePath}.tmp`;
    const payload = `${JSON.stringify(normalized, null, 2)}\n`;

    await fs.writeFile(tmpPath, payload, 'utf8');
    if (process.platform !== 'win32') {
      await fs.chmod(tmpPath, 0o600);
    }
    await fs.rename(tmpPath, this.filePath);
    if (process.platform !== 'win32') {
      await fs.chmod(this.filePath, 0o600);
    }
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

export function createSecretStore(): SecretStore {
  return new FileSecretStore();
}
