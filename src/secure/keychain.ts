import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

import type { SecretProvider } from '../types/profile';
import { DEFAULT_SLOT_ID } from './key-slots';

const execFileAsync = promisify(execFile);
const SERVICE_NAME = '@xyte/cli';

export interface KeychainStore {
  setSecret(tenantId: string, provider: SecretProvider, value: string): Promise<void>;
  getSecret(tenantId: string, provider: SecretProvider): Promise<string | undefined>;
  clearSecret(tenantId: string, provider: SecretProvider): Promise<void>;
  setSlotSecret(tenantId: string, provider: SecretProvider, slotId: string, value: string): Promise<void>;
  getSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<string | undefined>;
  clearSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<void>;
}

function accountName(tenantId: string, provider: SecretProvider, slotId: string): string {
  return `${tenantId}:${provider}:${slotId}`;
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('bash', ['-lc', `command -v ${command}`]);
    return true;
  } catch {
    return false;
  }
}

class DarwinSecurityKeychain implements KeychainStore {
  async setSlotSecret(tenantId: string, provider: SecretProvider, slotId: string, value: string): Promise<void> {
    const account = accountName(tenantId, provider, slotId);
    await execFileAsync('security', [
      'add-generic-password',
      '-a',
      account,
      '-s',
      SERVICE_NAME,
      '-w',
      value,
      '-U'
    ]);
  }

  async getSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<string | undefined> {
    const account = accountName(tenantId, provider, slotId);
    return this.readAccount(account);
  }

  async clearSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<void> {
    await this.deleteAccount(accountName(tenantId, provider, slotId));
  }

  async setSecret(tenantId: string, provider: SecretProvider, value: string): Promise<void> {
    await this.setSlotSecret(tenantId, provider, DEFAULT_SLOT_ID, value);
  }

  async getSecret(tenantId: string, provider: SecretProvider): Promise<string | undefined> {
    return this.getSlotSecret(tenantId, provider, DEFAULT_SLOT_ID);
  }

  async clearSecret(tenantId: string, provider: SecretProvider): Promise<void> {
    await this.clearSlotSecret(tenantId, provider, DEFAULT_SLOT_ID);
  }

  private async readAccount(account: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-a',
        account,
        '-s',
        SERVICE_NAME,
        '-w'
      ]);
      const value = stdout.trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  private async deleteAccount(account: string): Promise<void> {
    try {
      await execFileAsync('security', ['delete-generic-password', '-a', account, '-s', SERVICE_NAME]);
    } catch {
      // no-op if secret does not exist
    }
  }
}

class LinuxSecretToolKeychain implements KeychainStore {
  async setSlotSecret(tenantId: string, provider: SecretProvider, slotId: string, value: string): Promise<void> {
    const account = accountName(tenantId, provider, slotId);
    await new Promise<void>((resolve, reject) => {
      const child = spawn('secret-tool', ['store', '--label', SERVICE_NAME, 'service', SERVICE_NAME, 'account', account], {
        stdio: ['pipe', 'ignore', 'pipe']
      });

      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(stderr || `secret-tool exited with code ${code ?? -1}`));
      });

      child.stdin.write(value);
      child.stdin.end();
    });
  }

  async getSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<string | undefined> {
    const account = accountName(tenantId, provider, slotId);
    return this.lookupAccount(account);
  }

  async clearSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<void> {
    await this.clearAccount(accountName(tenantId, provider, slotId));
  }

  async setSecret(tenantId: string, provider: SecretProvider, value: string): Promise<void> {
    await this.setSlotSecret(tenantId, provider, DEFAULT_SLOT_ID, value);
  }

  async getSecret(tenantId: string, provider: SecretProvider): Promise<string | undefined> {
    return this.getSlotSecret(tenantId, provider, DEFAULT_SLOT_ID);
  }

  async clearSecret(tenantId: string, provider: SecretProvider): Promise<void> {
    await this.clearSlotSecret(tenantId, provider, DEFAULT_SLOT_ID);
  }

  private async lookupAccount(account: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', SERVICE_NAME, 'account', account]);
      const value = stdout.trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  private async clearAccount(account: string): Promise<void> {
    try {
      await execFileAsync('secret-tool', ['clear', 'service', SERVICE_NAME, 'account', account]);
    } catch {
      // no-op
    }
  }
}

export class MemoryKeychain implements KeychainStore {
  private readonly values = new Map<string, string>();

  async setSlotSecret(tenantId: string, provider: SecretProvider, slotId: string, value: string): Promise<void> {
    this.values.set(accountName(tenantId, provider, slotId), value);
  }

  async getSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<string | undefined> {
    return this.values.get(accountName(tenantId, provider, slotId));
  }

  async clearSlotSecret(tenantId: string, provider: SecretProvider, slotId: string): Promise<void> {
    this.values.delete(accountName(tenantId, provider, slotId));
  }

  async setSecret(tenantId: string, provider: SecretProvider, value: string): Promise<void> {
    await this.setSlotSecret(tenantId, provider, DEFAULT_SLOT_ID, value);
  }

  async getSecret(tenantId: string, provider: SecretProvider): Promise<string | undefined> {
    return this.getSlotSecret(tenantId, provider, DEFAULT_SLOT_ID);
  }

  async clearSecret(tenantId: string, provider: SecretProvider): Promise<void> {
    await this.clearSlotSecret(tenantId, provider, DEFAULT_SLOT_ID);
  }
}

export async function createKeychainStore(): Promise<KeychainStore> {
  if (process.env.XYTE_CLI_KEYCHAIN_BACKEND === 'memory') {
    return new MemoryKeychain();
  }

  if (process.platform === 'darwin') {
    return new DarwinSecurityKeychain();
  }

  if (process.platform === 'linux' && (await commandExists('secret-tool'))) {
    return new LinuxSecretToolKeychain();
  }

  throw new Error(
    'No supported OS keychain backend found. Use macOS keychain, libsecret (secret-tool), or set XYTE_CLI_KEYCHAIN_BACKEND=memory for tests.'
  );
}
