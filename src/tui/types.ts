import type blessed from 'blessed';

import type { XyteClient } from '../types/client';
import type { ProfileStore } from '../secure/profile-store';
import type { KeychainStore } from '../secure/keychain';
import type { ReadinessCheck } from '../config/readiness';

export type TuiScreenId = 'setup' | 'config' | 'dashboard' | 'spaces' | 'devices' | 'incidents' | 'tickets';
export type TuiPaneId = string;
export type TuiArrowKey = 'up' | 'down' | 'left' | 'right';
export type TuiArrowHandleResult = 'handled' | 'boundary' | 'unhandled';

export interface TuiContext {
  screen: blessed.Widgets.Screen;
  client: XyteClient;
  profileStore: ProfileStore;
  keychain: KeychainStore;
  getActiveTenantId(): Promise<string | undefined>;
  getReadiness(): ReadinessCheck | undefined;
  refreshReadiness(checkConnectivity?: boolean): Promise<ReadinessCheck>;
  setStatus(text: string): void;
  showError(error: unknown): void;
  debugLog?(event: string, data?: Record<string, unknown>): void;
  prompt(message: string, initial?: string): Promise<string | undefined>;
  promptSecret(message: string, initial?: string): Promise<string | undefined>;
  confirmWrite(actionLabel: string, token: string): Promise<boolean>;
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
