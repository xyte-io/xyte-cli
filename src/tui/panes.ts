import type { TuiPaneId, TuiScreenId } from './types';

export interface ScreenPaneConfig {
  panes: TuiPaneId[];
  defaultPane: TuiPaneId;
}

export const SCREEN_PANE_CONFIG: Record<TuiScreenId, ScreenPaneConfig> = {
  setup: {
    panes: ['providers-table', 'checklist-box'],
    defaultPane: 'providers-table'
  },
  config: {
    panes: ['providers-table', 'slots-table', 'actions-box'],
    defaultPane: 'providers-table'
  },
  dashboard: {
    panes: ['kpi', 'provider', 'incidents', 'tickets'],
    defaultPane: 'kpi'
  },
  spaces: {
    panes: ['spaces-table', 'detail-box', 'devices-table'],
    defaultPane: 'spaces-table'
  },
  devices: {
    panes: ['devices-table', 'detail-box'],
    defaultPane: 'devices-table'
  },
  incidents: {
    panes: ['incidents-table', 'detail-box', 'triage-box'],
    defaultPane: 'incidents-table'
  },
  tickets: {
    panes: ['tickets-table', 'detail-box', 'draft-box'],
    defaultPane: 'tickets-table'
  },
  copilot: {
    panes: ['prompt-input', 'provider-box', 'output-box'],
    defaultPane: 'prompt-input'
  }
};
