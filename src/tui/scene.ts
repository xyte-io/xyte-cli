import type { TuiScreenId } from './types';
import { safePreviewLines } from './serialize';
import { fitCell, formatBoolTag, sanitizePrintable, shortId } from './table-format';
import { HEADLESS_FRAME_SCHEMA_VERSION } from '../contracts/versions';

export type FrameInputState = 'idle' | 'modal' | 'busy';
export type FrameTransitionState = 'idle' | 'switching';
export type FrameRefreshState = 'idle' | 'loading' | 'retrying' | 'error';

export interface HeadlessFrameMeta {
  inputState: FrameInputState;
  queueDepth: number;
  droppedEvents: number;
  transitionState: FrameTransitionState;
  refreshState: FrameRefreshState;
  activePane?: string;
  availablePanes?: string[];
  navigationMode?: 'pane-focus';
  tabId?: TuiScreenId;
  tabOrder?: TuiScreenId[];
  tabNavBoundary?: 'left' | 'right' | null;
  renderSafety?: 'ok' | 'truncated';
  tableFormat?: 'compact-v1';
  contract?: {
    frameVersion: string;
    tableFormat: string;
    navigationMode: string;
  };
  [key: string]: unknown;
}

export interface SceneStat {
  label: string;
  value: string | number;
}

export interface SceneText {
  lines: string[];
}

export interface SceneTable {
  columns: string[];
  rows: Array<Array<string | number>>;
}

export interface ScenePanel {
  id: string;
  title: string;
  kind: 'stats' | 'text' | 'table';
  stats?: SceneStat[];
  text?: SceneText;
  table?: SceneTable;
  status?: string;
}

export interface HeadlessFrame {
  schemaVersion: typeof HEADLESS_FRAME_SCHEMA_VERSION;
  timestamp: string;
  sessionId: string;
  sequence: number;
  mode: 'headless' | 'interactive';
  screen: TuiScreenId;
  title: string;
  status: string;
  tenantId?: string;
  motionEnabled: boolean;
  motionPhase: number;
  logo: string;
  panels: ScenePanel[];
  meta?: HeadlessFrameMeta;
}

export interface DashboardSceneState {
  tenantId?: string;
  provider?: string;
  model?: string;
  devices: any[];
  incidents: any[];
  tickets: any[];
}

export interface DevicesSceneState {
  tenantId?: string;
  searchText: string;
  selectedIndex: number;
  devices: any[];
}

export interface IncidentsSceneState {
  tenantId?: string;
  severityFilter: string;
  selectedIndex: number;
  incidents: any[];
  triageText?: string;
}

export interface TicketsSceneState {
  tenantId?: string;
  mode: 'organization' | 'partner';
  searchText: string;
  selectedIndex: number;
  tickets: any[];
  detailText?: string;
  draftText?: string;
}

export interface SpacesSceneState {
  tenantId?: string;
  searchText: string;
  selectedIndex: number;
  loading: boolean;
  paneStatus: string;
  spaces: any[];
  spaceDetail?: unknown;
  devicesInSpace: any[];
}

export interface CopilotSceneState {
  tenantId?: string;
  provider?: string;
  model?: string;
  logs: string[];
}

export interface SetupSceneState {
  tenantId?: string;
  readinessState: 'ready' | 'needs_setup' | 'degraded';
  connectionState: string;
  missingItems: string[];
  recommendedActions: string[];
  providerRows: Array<{ provider: string; slotCount: number; activeSlot: string; hasSecret: string }>;
}

export interface ConfigSceneState {
  tenantId?: string;
  providerRows: Array<{ provider: string; slotCount: number; activeSlot: string; hasSecret: string; lastValidatedAt?: string }>;
  selectedProvider?: string;
  slotRows: Array<{ provider: string; slotId: string; name: string; active: string; hasSecret: string; fingerprint: string }>;
  selectedSlot?: { provider: string; slotId: string; name: string; active: string; hasSecret: string; fingerprint: string };
  doctorStatus?: string;
}

function sampleRows(items: any[], count = 6): any[] {
  return items.slice(0, count);
}

function safeId(item: any, index: number): string {
  return String(item?.id ?? item?._id ?? item?.uuid ?? item?.device_id ?? `row-${index + 1}`);
}

function safeName(item: any): string {
  return String(item?.name ?? item?.title ?? item?.subject ?? item?.status ?? 'n/a');
}

function safeStatus(item: any): string {
  return String(item?.status ?? item?.state ?? item?.online_status ?? 'unknown');
}

function safeSpaceId(item: any, index: number): string {
  return String(item?.id ?? item?.space_id ?? item?._id ?? item?.uuid ?? `space-${index + 1}`);
}

function detailBlock(lines: string[], preview?: { lines: string[] }): string[] {
  if (!preview) {
    return lines;
  }
  return [...lines, '', 'Preview:', ...preview.lines];
}

function clampSelection(index: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(index, total - 1));
}

export function sceneFromDashboardState(state: DashboardSceneState): ScenePanel[] {
  return [
    {
      id: 'dashboard-kpis',
      title: 'KPI',
      kind: 'stats',
      stats: [
        { label: 'Tenant', value: state.tenantId ?? 'none' },
        { label: 'Devices', value: state.devices.length },
        { label: 'Open incidents', value: state.incidents.length },
        { label: 'Open tickets', value: state.tickets.length }
      ]
    },
    {
      id: 'dashboard-provider',
      title: 'Provider Status',
      kind: 'text',
      text: {
        lines: [
          `Provider override: ${state.provider ?? 'none'}`,
          `Model override: ${state.model ?? 'none'}`,
          'Copilot outputs are advisory only.'
        ]
      }
    },
    {
      id: 'dashboard-incidents',
      title: 'Recent Incidents',
      kind: 'table',
      table: {
        columns: ['ID', 'Name', 'State'],
        rows: sampleRows(state.incidents).map((item, index) => [
          shortId(safeId(item, index)),
          fitCell(safeName(item), 26, 'end'),
          fitCell(safeStatus(item), 10, 'end')
        ])
      }
    },
    {
      id: 'dashboard-tickets',
      title: 'Recent Tickets',
      kind: 'table',
      table: {
        columns: ['ID', 'Subject', 'State'],
        rows: sampleRows(state.tickets).map((item, index) => [
          shortId(safeId(item, index)),
          fitCell(safeName(item), 26, 'end'),
          fitCell(safeStatus(item), 10, 'end')
        ])
      }
    }
  ];
}

export function sceneFromDevicesState(state: DevicesSceneState): ScenePanel[] {
  const selectedIndex = clampSelection(state.selectedIndex, state.devices.length);
  const selected = state.devices[selectedIndex];
  const preview = selected ? safePreviewLines(selected) : undefined;
  const detailLines = selected
    ? detailBlock(
        [
          `ID: ${sanitizePrintable(selected?.id ?? selected?._id ?? selected?.uuid ?? 'n/a')}`,
          `Name: ${sanitizePrintable(selected?.name ?? selected?.title ?? 'n/a')}`,
          `State: ${sanitizePrintable(selected?.status ?? selected?.state ?? selected?.online_status ?? 'unknown')}`,
          `Space: ${sanitizePrintable(selected?.space_name ?? selected?.space_id ?? 'n/a')}`
        ],
        preview
      )
    : ['No matching devices.'];

  return [
    {
      id: 'devices-table',
      title: 'Devices',
      kind: 'table',
      table: {
        columns: ['ID', 'Name', 'State', 'Space'],
        rows: state.devices.map((item, index) => [
          shortId(safeId(item, index)),
          fitCell(safeName(item), 24, 'end'),
          fitCell(safeStatus(item), 10, 'end'),
          fitCell(item?.space_name ?? item?.space_id ?? 'n/a', 20, 'end')
        ])
      },
      status: state.searchText ? `filter=${state.searchText}` : 'filter=none'
    },
    {
      id: 'devices-detail',
      title: 'Device Detail',
      kind: 'text',
      text: {
        lines: detailLines
      }
    }
  ];
}

export function sceneFromIncidentsState(state: IncidentsSceneState): ScenePanel[] {
  const selectedIndex = clampSelection(state.selectedIndex, state.incidents.length);
  const selected = state.incidents[selectedIndex];
  const preview = selected ? safePreviewLines(selected) : undefined;
  const detailLines = selected
    ? detailBlock(
        [
          `ID: ${sanitizePrintable(selected?.id ?? selected?._id ?? selected?.uuid ?? 'n/a')}`,
          `Sev: ${sanitizePrintable(selected?.severity ?? selected?.priority ?? 'unknown')}`,
          `State: ${sanitizePrintable(selected?.status ?? selected?.state ?? 'unknown')}`,
          `Device: ${sanitizePrintable(selected?.device_id ?? selected?.device?.id ?? 'n/a')}`
        ],
        preview
      )
    : ['No incidents.'];

  return [
    {
      id: 'incidents-table',
      title: 'Incidents',
      kind: 'table',
      table: {
        columns: ['ID', 'Sev', 'State', 'Device'],
        rows: state.incidents.map((item, index) => [
          shortId(safeId(item, index)),
          fitCell(item?.severity ?? item?.priority ?? 'unknown', 7, 'end'),
          fitCell(safeStatus(item), 10, 'end'),
          shortId(item?.device_id ?? item?.device?.id ?? 'n/a')
        ])
      },
      status: state.severityFilter ? `severity=${state.severityFilter}` : 'severity=all'
    },
    {
      id: 'incidents-detail',
      title: 'Incident Detail',
      kind: 'text',
      text: {
        lines: detailLines
      }
    },
    {
      id: 'incidents-triage',
      title: 'Triage',
      kind: 'text',
      text: {
        lines: state.triageText ? state.triageText.split('\n') : ['Run triage from interactive mode with key x.']
      }
    }
  ];
}

export function sceneFromTicketsState(state: TicketsSceneState): ScenePanel[] {
  const selectedIndex = clampSelection(state.selectedIndex, state.tickets.length);
  const selected = state.tickets[selectedIndex];
  const preview = selected ? safePreviewLines(selected) : undefined;
  const selectedSummary = selected
    ? [
        `ID: ${sanitizePrintable(selected?.id ?? selected?._id ?? 'n/a')}`,
        `State: ${sanitizePrintable(selected?.status ?? selected?.state ?? 'unknown')}`,
        `Pri: ${sanitizePrintable(selected?.priority ?? 'n/a')}`,
        `Subject: ${sanitizePrintable(selected?.subject ?? selected?.title ?? 'n/a')}`,
        ''
      ]
    : [];
  const detailLines = state.detailText
    ? [...selectedSummary, ...state.detailText.split('\n')]
    : selected
      ? detailBlock(selectedSummary, preview)
      : ['No tickets.'];

  return [
    {
      id: 'tickets-table',
      title: 'Tickets',
      kind: 'table',
      table: {
        columns: ['ID', 'State', 'Pri', 'Subject'],
        rows: state.tickets.map((item, index) => [
          shortId(safeId(item, index)),
          fitCell(safeStatus(item), 10, 'end'),
          fitCell(item?.priority ?? 'n/a', 6, 'end'),
          fitCell(item?.subject ?? item?.title ?? 'n/a', 28, 'end')
        ])
      },
      status: `mode=${state.mode}${state.searchText ? ` filter=${state.searchText}` : ''}`
    },
    {
      id: 'tickets-detail',
      title: 'Ticket Detail',
      kind: 'text',
      text: {
        lines: detailLines
      }
    },
    {
      id: 'tickets-draft',
      title: 'Draft Tool',
      kind: 'text',
      text: {
        lines: state.draftText ? state.draftText.split('\n') : ['Run draft from interactive mode with key m.']
      }
    }
  ];
}

export function sceneFromSpacesState(state: SpacesSceneState): ScenePanel[] {
  const selectedIndex = clampSelection(state.selectedIndex, state.spaces.length);
  const selected = state.spaces[selectedIndex];
  const detailPreview = state.spaceDetail ? safePreviewLines(state.spaceDetail) : selected ? safePreviewLines(selected) : undefined;
  const detailLines = selected
    ? detailBlock(
        [
          `ID: ${sanitizePrintable(safeSpaceId(selected, selectedIndex))}`,
          `Name: ${sanitizePrintable(selected?.name ?? selected?.title ?? 'n/a')}`,
          `Type: ${sanitizePrintable(selected?.space_type ?? selected?.type ?? 'n/a')}`,
          `Path: ${sanitizePrintable(selected?.path ?? selected?.full_path ?? 'n/a')}`
        ],
        detailPreview
      )
    : ['No spaces.'];

  return [
    {
      id: 'spaces-list',
      title: 'Spaces',
      kind: 'table',
      table: {
        columns: ['ID', 'Name', 'Type', 'Path'],
        rows: state.spaces.map((item, index) => [
          shortId(safeId(item, index)),
          fitCell(safeName(item), 22, 'end'),
          fitCell(item?.space_type ?? item?.type ?? 'n/a', 10, 'end'),
          fitCell(item?.path ?? item?.full_path ?? 'n/a', 28, 'end')
        ])
      },
      status: state.searchText ? `filter=${state.searchText}` : 'filter=none'
    },
    {
      id: 'spaces-detail',
      title: 'Space Detail',
      kind: 'text',
      text: {
        lines: detailLines
      },
      status: state.loading ? 'loading=1' : 'loading=0'
    },
    {
      id: 'spaces-devices',
      title: 'Devices In Space',
      kind: 'table',
      table: {
        columns: ['ID', 'Name', 'State'],
        rows: state.devicesInSpace.map((item, index) => [
          shortId(safeId(item, index)),
          fitCell(safeName(item), 24, 'end'),
          fitCell(safeStatus(item), 10, 'end')
        ])
      },
      status: state.paneStatus
    }
  ];
}

export function sceneFromCopilotState(state: CopilotSceneState): ScenePanel[] {
  return [
    {
      id: 'copilot-status',
      title: 'Provider',
      kind: 'text',
      text: {
        lines: [
          `Provider override: ${state.provider ?? 'none'}`,
          `Model override: ${state.model ?? 'none'}`,
          `Tenant: ${state.tenantId ?? 'none'}`
        ]
      }
    },
    {
      id: 'copilot-log',
      title: 'Output',
      kind: 'text',
      text: {
        lines: state.logs.length
          ? state.logs
          : ['Use interactive mode to run prompts. In headless mode, this view is a snapshot of current copilot log state.']
      }
    }
  ];
}

export function sceneFromSetupState(state: SetupSceneState): ScenePanel[] {
  return [
    {
      id: 'setup-overview',
      title: 'Setup Readiness',
      kind: 'stats',
      stats: [
        { label: 'Readiness', value: state.readinessState },
        { label: 'Tenant', value: state.tenantId ?? 'none' },
        { label: 'Connection', value: state.connectionState }
      ]
    },
    {
      id: 'setup-providers',
      title: 'Provider Slots',
      kind: 'table',
      table: {
        columns: ['Provider', 'Slots', 'Active Slot', 'Has Secret'],
        rows: state.providerRows.map((row) => [
          fitCell(row.provider, 20, 'end'),
          row.slotCount,
          shortId(row.activeSlot),
          formatBoolTag(row.hasSecret)
        ])
      }
    },
    {
      id: 'setup-checklist',
      title: 'Checklist',
      kind: 'text',
      text: {
        lines: [
          ...(state.missingItems.length ? ['Missing:'] : ['No missing setup items.']),
          ...(state.missingItems.length ? state.missingItems.map((item) => `- ${item}`) : []),
          '',
          ...(state.recommendedActions.length ? ['Recommended actions:'] : ['No recommendations.']),
          ...state.recommendedActions.map((item) => `- ${item}`),
          '',
          'Interactive actions:',
          '- a add tenant',
          '- u use tenant',
          '- k guided key wizard (provider -> slot -> secret -> review)',
          '- p set active slot',
          '- c test connectivity',
          '- r refresh',
          'Global keys: u/g/d/s/v/i/t/p, r refresh, ? help, q quit'
        ]
      }
    }
  ];
}

export function sceneFromConfigState(state: ConfigSceneState): ScenePanel[] {
  const selectedSlot = state.selectedSlot;
  return [
    {
      id: 'config-providers',
      title: 'Provider Health',
      kind: 'table',
      table: {
        columns: ['Provider', 'Slots', 'Active Slot', 'Has Secret', 'Last Validated'],
        rows: state.providerRows.map((row) => [
          fitCell(row.provider, 16, 'end'),
          row.slotCount,
          shortId(row.activeSlot, { head: 4, tail: 3 }),
          formatBoolTag(row.hasSecret),
          fitCell(row.lastValidatedAt ?? 'n/a', 18, 'end')
        ])
      }
    },
    {
      id: 'config-slots',
      title: 'Key Slots',
      kind: 'table',
      table: {
        columns: ['Provider', 'Slot', 'Active', 'Secret'],
        rows: state.slotRows.map((row) => [
          fitCell(row.provider, 16, 'end'),
          fitCell(`${row.name} (${shortId(row.slotId, { head: 4, tail: 3 })})`, 26, 'end'),
          formatBoolTag(row.active),
          formatBoolTag(row.hasSecret)
        ])
      }
    },
    {
      id: 'config-actions',
      title: 'Actions',
      kind: 'text',
      text: {
        lines: [
          `Tenant: ${state.tenantId ?? 'none'}`,
          `Provider: ${state.selectedProvider ?? 'none'}`,
          `Doctor: ${state.doctorStatus ?? 'not run'}`,
          '',
          ...(selectedSlot
            ? [
                'Selected slot:',
                `- Provider: ${selectedSlot.provider}`,
                `- Slot: ${selectedSlot.name} (${selectedSlot.slotId})`,
                `- Fingerprint: ${selectedSlot.fingerprint}`,
                `- Active: ${formatBoolTag(selectedSlot.active)}`,
                `- Secret stored: ${formatBoolTag(selectedSlot.hasSecret)}`,
                ''
              ]
            : ['Selected slot: none', '']),
          'Interactive actions:',
          '- a add slot (guided wizard)',
          '- n rename slot',
          '- u use slot',
          '- e rotate/update key (guided wizard)',
          '- t test selected slot',
          '- x remove slot',
          '- c doctor',
          '- r refresh',
          'Global keys: u/g/d/s/v/i/t/p, r refresh, ? help, q quit'
        ]
      }
    }
  ];
}

export function createHeadlessFrame(args: {
  sessionId: string;
  sequence: number;
  screen: TuiScreenId;
  title: string;
  status: string;
  tenantId?: string;
  motionEnabled: boolean;
  motionPhase: number;
  logo: string;
  panels: ScenePanel[];
  meta?: Partial<HeadlessFrameMeta>;
}): HeadlessFrame {
  const defaultMeta: HeadlessFrameMeta = {
    inputState: 'idle',
    queueDepth: 0,
    droppedEvents: 0,
    transitionState: 'idle',
    refreshState: 'idle',
    navigationMode: 'pane-focus',
    availablePanes: [],
    activePane: '',
    tabNavBoundary: null,
    renderSafety: 'ok',
    tableFormat: 'compact-v1',
    contract: {
      frameVersion: HEADLESS_FRAME_SCHEMA_VERSION,
      tableFormat: 'compact-v1',
      navigationMode: 'pane-focus'
    }
  };
  return {
    schemaVersion: HEADLESS_FRAME_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    sessionId: args.sessionId,
    sequence: args.sequence,
    mode: 'headless',
    screen: args.screen,
    title: args.title,
    status: args.status,
    tenantId: args.tenantId,
    motionEnabled: args.motionEnabled,
    motionPhase: args.motionPhase,
    logo: args.logo,
    panels: args.panels,
    meta: {
      ...defaultMeta,
      ...(args.meta ?? {})
    }
  };
}
