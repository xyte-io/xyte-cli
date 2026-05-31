import type { PublicEndpointSpec } from './endpoints';
import type { HttpTransport } from '../http/transport';
import type { SecretStore } from '../secure/secret-store';
import type { ProfileStore } from '../secure/profile-store';

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

export interface OrganizationNamespace {
  closeIncident: NamespaceCall;
  cancelCommand: NamespaceCall;
  getCommands: NamespaceCall;
  sendCommand: NamespaceCall;
  claimDevice: NamespaceCall;
  mergeDevice: NamespaceCall;
  splitDevice: NamespaceCall;
  updateDevice: NamespaceCall;
  deleteDevice: NamespaceCall;
  getDevice: NamespaceCall;
  getDevices: NamespaceCall;
  getHistories: NamespaceCall;
  getOrganizationInfo: NamespaceCall;
  getIncidents: NamespaceCall;
  createSpace: NamespaceCall;
  deleteSpace: NamespaceCall;
  findOrCreateSpace: NamespaceCall;
  getSpace: NamespaceCall;
  getSpaces: NamespaceCall;
  updateSpace: NamespaceCall;
  getTicket: NamespaceCall;
  getTickets: NamespaceCall;
  markResolved: NamespaceCall;
  sendMessage: NamespaceCall;
  updateTicket: NamespaceCall;
}

export interface PartnerNamespace {
  deleteDevice: NamespaceCall;
  getCommands: NamespaceCall;
  getConfiguration: NamespaceCall;
  getDeviceInfo: NamespaceCall;
  getDevices: NamespaceCall;
  getStateHistory: NamespaceCall;
  getStateHistoryMultiDevices: NamespaceCall;
  getTelemetries: NamespaceCall;
  addComment: NamespaceCall;
  closeTicket: NamespaceCall;
  getTicket: NamespaceCall;
  getTickets: NamespaceCall;
  updateTicket: NamespaceCall;
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
