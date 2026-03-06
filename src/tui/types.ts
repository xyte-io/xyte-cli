import type blessed from 'blessed';

import type { XyteClient } from '../types/client';
import type { ProfileStore } from '../secure/profile-store';
import type { SecretStore } from '../secure/secret-store';
import type { ReadinessCheck } from '../config/readiness';

export type TuiScreenId = 'setup' | 'config' | 'dashboard' | 'spaces' | 'devices' | 'incidents' | 'tickets';
export type TuiPaneId = string;
export type TuiArrowKey = 'up' | 'down' | 'left' | 'right';
export type TuiArrowHandleResult = 'handled' | 'boundary' | 'unhandled';

export interface TuiChoiceItem {
  label: string;
  hint?: string;
  disabled?: boolean;
  disabledReason?: string;
}

export interface TuiContext {
  screen: blessed.Widgets.Screen;
  client: XyteClient;
  profileStore: ProfileStore;
  secretStore: SecretStore;
  getActiveTenantId(): Promise<string | undefined>;
  getReadiness(): ReadinessCheck | undefined;
  refreshReadiness(checkConnectivity?: boolean): Promise<ReadinessCheck>;
  setStatus(text: string): void;
  showError(error: unknown): void;
  debugLog?(event: string, data?: Record<string, unknown>): void;
  prompt(message: string, initial?: string): Promise<string | undefined>;
  promptSecret(message: string, initial?: string): Promise<string | undefined>;
  choose?(args: { title: string; items: TuiChoiceItem[]; initialIndex?: number }): Promise<number | undefined>;
  confirmWrite(actionLabel: string, token: string): Promise<boolean>;
  switchScreen?(screenId: TuiScreenId): Promise<void>;
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
  getNavigationTrail?(): string[];
  goBack?(): Promise<boolean> | boolean;
  handleArrow?(key: TuiArrowKey): Promise<TuiArrowHandleResult>;
  handleKey?(ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg): Promise<boolean>;
}
