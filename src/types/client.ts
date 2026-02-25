import type { PublicEndpointSpec } from './endpoints';
import type { HttpTransport } from '../http/transport';
import type { SecretStore } from '../secure/secret-store';
import type { ProfileStore } from '../secure/profile-store';
import type { OrganizationNamespace } from '../namespaces/organization';
import type { PartnerNamespace } from '../namespaces/partner';

export interface XyteCallArgs {
  requestId?: string;
  path?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
  tenantId?: string;
}

export interface XyteCallResult<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
  durationMs: number;
  retryCount: number;
  attempts: number;
}

export type NamespaceCall = (args?: XyteCallArgs) => Promise<unknown>;

export interface XyteNamespace {
  [method: string]: NamespaceCall;
}

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

export interface XyteClient {
  organization: OrganizationNamespace;
  partner: PartnerNamespace;
  call<T = unknown>(endpointKey: string, args?: XyteCallArgs): Promise<T>;
  callWithMeta<T = unknown>(endpointKey: string, args?: XyteCallArgs): Promise<XyteCallResult<T>>;
  describeEndpoint(key: string): PublicEndpointSpec;
  listEndpoints(): PublicEndpointSpec[];
  listTenantEndpoints(tenantId: string): Promise<PublicEndpointSpec[]>;
}
