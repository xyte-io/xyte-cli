import type { TuiScreenId } from './types';
import { safePreviewLines } from './serialize';
import { fitCell, formatBoolTag, sanitizePrintable, shortId } from './table-format';
import { HEADLESS_FRAME_SCHEMA_VERSION } from '../contracts/versions';
import type { ProviderReadiness } from '../config/readiness';

export function toSetupProviderRows(providers: ProviderReadiness[]) {
  return providers.map((provider) => ({
    provider: provider.provider,
    slotCount: provider.slotCount,
    activeSlot: provider.activeSlotId ?? 'none',
    hasSecret: provider.hasActiveSecret ? 'yes' : 'no'
  }));
}

type FrameInputState = 'idle' | 'modal' | 'busy';
type FrameTransitionState = 'idle' | 'switching';
type FrameRefreshState = 'idle' | 'loading' | 'retrying' | 'error';

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

type ApiRecord = Record<string, unknown>;

interface DashboardSceneState {
  tenantId?: string;
  devices: unknown[];
  incidents: unknown[];
  tickets: unknown[];
}

interface DevicesSceneState {
  tenantId?: string;
  searchText: string;
  selectedIndex: number;
  devices: unknown[];
  spaceFilter?: string;
  actionsHint?: string;
}

interface IncidentsSceneState {
  tenantId?: string;
  severityFilter: string;
  selectedIndex: number;
  incidents: unknown[];
  statusFilter?: string;
  priorityFilter?: string;
  page?: number;
  perPage?: number;
  actionsHint?: string;
}

interface TicketsSceneState {
  tenantId?: string;
  mode: 'organization' | 'partner';
  searchText: string;
  selectedIndex: number;
  tickets: unknown[];
  detailText?: string;
  statusFilter?: string;
  priorityFilter?: string;
  page?: number;
  perPage?: number;
  totalFiltered?: number;
  actionsHint?: string;
}

interface SpacesSceneState {
  tenantId?: string;
  searchText: string;
  selectedIndex: number;
  loading: boolean;
  paneStatus: string;
  spaces: unknown[];
  spaceDetail?: unknown;
  devicesInSpace: unknown[];
  endpointFilterSummary?: string;
  actionsHint?: string;
}

interface SetupSceneState {
  tenantId?: string;
  readinessState: 'ready' | 'needs_setup' | 'degraded';
  connectionState: string;
  missingItems: string[];
  recommendedActions: string[];
  providerRows: Array<{ provider: string; slotCount: number; activeSlot: string; hasSecret: string }>;
}

interface ConfigSceneState {
  tenantId?: string;
  providerRows: Array<{ provider: string; slotCount: number; activeSlot: string; hasSecret: string; lastValidatedAt?: string }>;
  selectedProvider?: string;
  slotRows: Array<{ provider: string; slotId: string; name: string; active: string; hasSecret: string; fingerprint: string }>;
  selectedSlot?: { provider: string; slotId: string; name: string; active: string; hasSecret: string; fingerprint: string };
  doctorStatus?: string;
}

function asRec(item: unknown): ApiRecord {
  return item && typeof item === 'object' ? (item as ApiRecord) : {};
}

function sampleRows(items: unknown[], count = 6): unknown[] {
  return items.slice(0, count);
}

function safeId(item: unknown, index: number): string {
  const rec = asRec(item);
  return String(rec.id ?? rec._id ?? rec.uuid ?? rec.device_id ?? `row-${index + 1}`);
}

function safeName(item: unknown): string {
  const rec = asRec(item);
  return String(rec.name ?? rec.title ?? rec.subject ?? rec.status ?? 'n/a');
}

function safeStatus(item: unknown): string {
  const rec = asRec(item);
  return String(rec.status ?? rec.state ?? rec.online_status ?? 'unknown');
}

function safeSpaceId(item: unknown, index: number): string {
  const rec = asRec(item);
  return String(rec.id ?? rec.space_id ?? rec._id ?? rec.uuid ?? `space-${index + 1}`);
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
      id: 'dashboard-status',
      title: 'Status',
      kind: 'text',
      text: {
        lines: [
          'Use setup/config to manage tenant readiness and key slots.',
          'Headless mode provides machine-readable snapshots for agents.'
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
  const sel = asRec(selected);
  const preview = selected ? safePreviewLines(selected) : undefined;
  const detailLines = selected
    ? detailBlock(
        [
          `ID: ${sanitizePrintable(sel.id ?? sel._id ?? sel.uuid ?? 'n/a')}`,
          `Name: ${sanitizePrintable(sel.name ?? sel.title ?? 'n/a')}`,
          `State: ${sanitizePrintable(sel.status ?? sel.state ?? sel.online_status ?? 'unknown')}`,
          `Space: ${sanitizePrintable(sel.space_name ?? sel.space_id ?? 'n/a')}`
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
        rows: state.devices.map((item, index) => {
          const r = asRec(item);
          return [
            shortId(safeId(item, index)),
            fitCell(safeName(item), 24, 'end'),
            fitCell(safeStatus(item), 10, 'end'),
            fitCell(r.space_name ?? r.space_id ?? 'n/a', 20, 'end')
          ];
        })
      },
      status: [
        state.searchText ? `search=${state.searchText}` : 'search=none',
        state.spaceFilter ? `space_id=${state.spaceFilter}` : 'space_id=all',
        state.actionsHint ?? 'actions=a'
      ].join(' | ')
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
  const sel = asRec(selected);
  const preview = selected ? safePreviewLines(selected) : undefined;
  const selDevice = sel.device && typeof sel.device === 'object' ? (sel.device as ApiRecord) : undefined;
  const detailLines = selected
    ? detailBlock(
        [
          `ID: ${sanitizePrintable(sel.id ?? sel._id ?? sel.uuid ?? 'n/a')}`,
          `Sev: ${sanitizePrintable(sel.severity ?? sel.priority ?? 'unknown')}`,
          `State: ${sanitizePrintable(sel.status ?? sel.state ?? 'unknown')}`,
          `Device: ${sanitizePrintable(sel.device_id ?? selDevice?.id ?? 'n/a')}`
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
        rows: state.incidents.map((item, index) => {
          const r = asRec(item);
          const rDevice = r.device && typeof r.device === 'object' ? (r.device as ApiRecord) : undefined;
          return [
            shortId(safeId(item, index)),
            fitCell(r.severity ?? r.priority ?? 'unknown', 7, 'end'),
            fitCell(safeStatus(item), 10, 'end'),
            shortId(r.device_id ?? rDevice?.id ?? 'n/a')
          ];
        })
      },
      status: [
        state.severityFilter ? `severity=${state.severityFilter}` : 'severity=all',
        state.statusFilter ? `status=${state.statusFilter}` : 'status=all',
        state.priorityFilter ? `priority=${state.priorityFilter}` : 'priority=all',
        `page=${state.page ?? 1}`,
        `per=${state.perPage ?? 100}`,
        state.actionsHint ?? 'actions=a'
      ].join(' | ')
    },
    {
      id: 'incidents-detail',
      title: 'Incident Detail',
      kind: 'text',
      text: {
        lines: detailLines
      }
    },
  ];
}

export function sceneFromTicketsState(state: TicketsSceneState): ScenePanel[] {
  const selectedIndex = clampSelection(state.selectedIndex, state.tickets.length);
  const selected = state.tickets[selectedIndex];
  const sel = asRec(selected);
  const preview = selected ? safePreviewLines(selected) : undefined;
  const selectedSummary = selected
    ? [
        `ID: ${sanitizePrintable(sel.id ?? sel._id ?? 'n/a')}`,
        `State: ${sanitizePrintable(sel.status ?? sel.state ?? 'unknown')}`,
        `Pri: ${sanitizePrintable(sel.priority ?? 'n/a')}`,
        `Subject: ${sanitizePrintable(sel.subject ?? sel.title ?? 'n/a')}`,
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
        rows: state.tickets.map((item, index) => {
          const r = asRec(item);
          return [
            shortId(safeId(item, index)),
            fitCell(safeStatus(item), 10, 'end'),
            fitCell(r.priority ?? 'n/a', 6, 'end'),
            fitCell(r.subject ?? r.title ?? 'n/a', 28, 'end')
          ];
        })
      },
      status: [
        `mode=${state.mode}`,
        state.searchText ? `search=${state.searchText}` : 'search=none',
        state.statusFilter ? `status=${state.statusFilter}` : 'status=all',
        state.priorityFilter ? `priority=${state.priorityFilter}` : 'priority=all',
        `page=${state.page ?? 1}`,
        `per=${state.perPage ?? 25}`,
        `rows=${state.totalFiltered ?? state.tickets.length}`,
        state.actionsHint ?? 'actions=a'
      ].join(' | ')
    },
    {
      id: 'tickets-detail',
      title: 'Ticket Detail',
      kind: 'text',
      text: {
        lines: detailLines
      }
    }
  ];
}

export function sceneFromSpacesState(state: SpacesSceneState): ScenePanel[] {
  const selectedIndex = clampSelection(state.selectedIndex, state.spaces.length);
  const selected = state.spaces[selectedIndex];
  const sel = asRec(selected);
  const detailPreview = state.spaceDetail ? safePreviewLines(state.spaceDetail) : selected ? safePreviewLines(selected) : undefined;
  const detailLines = selected
    ? detailBlock(
        [
          `ID: ${sanitizePrintable(safeSpaceId(selected, selectedIndex))}`,
          `Name: ${sanitizePrintable(sel.name ?? sel.title ?? 'n/a')}`,
          `Type: ${sanitizePrintable(sel.space_type ?? sel.type ?? 'n/a')}`,
          `Path: ${sanitizePrintable(sel.path ?? sel.full_path ?? 'n/a')}`
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
        rows: state.spaces.map((item, index) => {
          const r = asRec(item);
          return [
            shortId(safeId(item, index)),
            fitCell(safeName(item), 22, 'end'),
            fitCell(r.space_type ?? r.type ?? 'n/a', 10, 'end'),
            fitCell(r.path ?? r.full_path ?? 'n/a', 28, 'end')
          ];
        })
      },
      status: [
        state.searchText ? `search=${state.searchText}` : 'search=none',
        state.endpointFilterSummary ? `endpoint=${state.endpointFilterSummary}` : 'endpoint=none',
        state.actionsHint ?? 'actions=a'
      ].join(' | ')
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
          'Global keys: u/g/d/s/v/i/t, r refresh, ? help, q quit'
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
          'Global keys: u/g/d/s/v/i/t, r refresh, ? help, q quit'
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
