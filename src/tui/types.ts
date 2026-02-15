import type blessed from 'blessed';

import type { XyteClient } from '../types/client';
import type { LLMProvider, LLMService } from '../llm/provider';
import type { ProfileStore } from '../secure/profile-store';
import type { KeychainStore } from '../secure/keychain';
import type { ReadinessCheck } from '../config/readiness';
import type {
  CommandSuggestionResult,
  HealthSummaryResult,
  IncidentTriageResult,
  TicketDraftResult
} from '../workflows/types';

export type TuiScreenId = 'setup' | 'config' | 'dashboard' | 'spaces' | 'devices' | 'incidents' | 'tickets' | 'copilot';
export type TuiPaneId = string;
export type TuiArrowKey = 'up' | 'down' | 'left' | 'right';
export type TuiArrowHandleResult = 'handled' | 'boundary' | 'unhandled';

export interface TuiProviderOverride {
  provider?: LLMProvider;
  model?: string;
}

export interface TuiContext {
  screen: blessed.Widgets.Screen;
  client: XyteClient;
  llm: LLMService;
  profileStore: ProfileStore;
  keychain: KeychainStore;
  getActiveTenantId(): Promise<string | undefined>;
  getReadiness(): ReadinessCheck | undefined;
  refreshReadiness(checkConnectivity?: boolean): Promise<ReadinessCheck>;
  getProviderOverride(): TuiProviderOverride;
  setProviderOverride(value: TuiProviderOverride): void;
  setStatus(text: string): void;
  showError(error: unknown): void;
  debugLog?(event: string, data?: Record<string, unknown>): void;
  prompt(message: string, initial?: string): Promise<string | undefined>;
  promptSecret(message: string, initial?: string): Promise<string | undefined>;
  confirmWrite(actionLabel: string, token: string): Promise<boolean>;
  runIncidentTriage(input: {
    incident: unknown;
    deviceContext?: unknown;
    ticketContext?: unknown;
    spaceContext?: unknown;
  }): Promise<IncidentTriageResult>;
  runTicketDraft(input: { ticket: unknown; thread?: unknown }): Promise<TicketDraftResult>;
  runHealthSummary(input: { devices?: unknown; incidents?: unknown; tickets?: unknown }): Promise<HealthSummaryResult>;
  runCommandSuggestions(input: {
    device: unknown;
    recentIncidents?: unknown;
    recentCommands?: unknown;
    goal?: string;
  }): Promise<CommandSuggestionResult>;
}

export interface TuiScreen {
  readonly id: TuiScreenId;
  readonly title: string;
  mount(parent: blessed.Widgets.Node, context: TuiContext): void;
  unmount(): void;
  refresh(): Promise<void>;
  focus?(): void;
  getActivePane?(): TuiPaneId;
  getAvailablePanes?(): TuiPaneId[];
  handleArrow?(key: TuiArrowKey): Promise<TuiArrowHandleResult>;
  handleKey?(ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg): Promise<boolean>;
}
