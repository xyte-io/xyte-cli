export { createXyteClient } from './client/create-client';
export { listEndpoints, getEndpoint, listEndpointKeys } from './client/catalog';

export type { XyteClient, XyteClientOptions, XyteCallArgs, XyteCallResult } from './types/client';
export type { PublicEndpointSpec } from './types/endpoints';

export {
  collectFleetSnapshot,
  buildFleetInspect,
  buildDeepDive,
  formatFleetInspectAscii,
  formatDeepDiveAscii,
  formatDeepDiveMarkdown,
  generateFleetReport
} from './workflows/fleet-insights';
export { generateOpsReport } from './workflows/ops-report';

export { FileProfileStore, createProfileStore } from './secure/profile-store';
export { createSecretStore, MemorySecretStore, FileSecretStore } from './secure/secret-store';
export type { SecretStore } from './secure/secret-store';
export type { ProfileStore } from './secure/profile-store';
export type {
  SecretProvider,
  TenantProfile,
  ProfileStoreData,
  ApiKeySlotMeta,
  TenantKeyRegistry
} from './types/profile';
