export { createXyteClient } from './client/create-client';
export { listEndpoints, getEndpoint, listEndpointKeys } from './client/catalog';

export type { XyteClient, XyteClientOptions, XyteCallArgs, XyteCallResult } from './types/client';
export type { PublicEndpointSpec } from './types/endpoints';

export { LLMService } from './llm/provider';
export type {
  LLMProvider,
  LLMProviderAdapter,
  LLMProviderConfig,
  LLMGenerateInput,
  LLMRunOptions,
  LLMResult
} from './llm/provider';

export { runIncidentTriage } from './workflows/incident-triage';
export { runTicketDraft } from './workflows/ticket-draft';
export { runHealthSummary } from './workflows/health-summary';
export { runCommandSuggestions } from './workflows/command-suggestions';
export {
  collectFleetSnapshot,
  buildFleetInspect,
  buildDeepDive,
  formatFleetInspectAscii,
  formatDeepDiveAscii,
  formatDeepDiveMarkdown,
  generateFleetReport
} from './workflows/fleet-insights';
export type {
  CommandSuggestionResult,
  HealthSummaryResult,
  IncidentTriageResult,
  TicketDraftResult
} from './workflows/types';

export { FileProfileStore } from './secure/profile-store';
export { createKeychainStore, MemoryKeychain } from './secure/keychain';
export type { ProfileStore } from './secure/profile-store';
export type { SecretProvider, TenantProfile, ProfileStoreData, ApiKeySlotMeta, TenantKeyRegistry } from './types/profile';
