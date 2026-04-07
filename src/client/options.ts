import type { HttpTransport } from '../http/transport';
import type { SecretStore } from '../secure/secret-store';
import type { ProfileStore } from '../secure/profile-store';

export interface XyteClientOptions {
  tenantId?: string;
  hubBaseUrl?: string;
  entryBaseUrl?: string;
  timeoutMs?: number;
  retryAttempts?: number;
  retryBackoffMs?: number;
  auth?: {
    organization?: string;
    partner?: string;
  };
  profileStore?: ProfileStore;
  secretStore?: SecretStore;
  transport?: HttpTransport;
}
