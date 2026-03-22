import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

import type { ConnectionState } from '../config/connectivity';
import { evaluateReadiness, type ReadinessCheck } from '../config/readiness';
import type { SecretStore } from '../secure/secret-store';
import type { ProfileStore } from '../secure/profile-store';
import type { XyteClient } from '../types/client';
import { startupFrames } from './animation';
import { XYTE_LOGO_COMPACT } from './assets/logo';
import {
  getSpaceId,
  readConfigData,
  loadDashboardData,
  loadDevicesData,
  loadIncidentsData,
  loadSpaceDrilldownData,
  loadSpacesData,
  loadTicketsData
} from './data-loaders';
import {
  createHeadlessFrame,
  sceneFromConfigState,
  sceneFromDashboardState,
  sceneFromDevicesState,
  sceneFromIncidentsState,
  sceneFromSetupState,
  sceneFromSpacesState,
  sceneFromTicketsState,
  toSetupProviderRows,
  type HeadlessFrame,
  type ScenePanel
} from './scene';
import type { TuiScreenId } from './types';
import { SCREEN_PANE_CONFIG } from './panes';
import { TAB_ORDER } from './tabs';

interface HeadlessRenderOptions {
  client: XyteClient;
  profileStore: ProfileStore;
  secretStore: SecretStore;
  screen: TuiScreenId;
  format: 'json';
  motionEnabled: boolean;
  follow?: boolean;
  intervalMs?: number;
  tenantId?: string;
  output?: Pick<typeof process.stdout, 'write'>;
}

type SafeWrite = (text: string) => boolean;

function getRefreshState(args: { connectionState: ReadinessCheck['connectionState']; retried?: boolean }): 'idle' | 'retrying' | 'error' {
  if (args.connectionState === 'connected' || args.connectionState === 'not_checked') {
    return 'idle';
  }
  if (args.retried) {
    return 'retrying';
  }
  return 'error';
}

function withNavigationMeta(screen: TuiScreenId, meta: Record<string, unknown> = {}) {
  const paneConfig = SCREEN_PANE_CONFIG[screen];
  return {
    tableFormat: 'compact-v1' as const,
    tabId: screen,
    tabOrder: TAB_ORDER,
    tabNavBoundary: null,
    renderSafety: 'ok' as const,
    headlessWrite: false,
    writePolicy: 'organization-only',
    activePane: paneConfig.defaultPane,
    availablePanes: paneConfig.panes,
    navigationMode: 'pane-focus' as const,
    ...meta
  };
}

function inferRenderSafety(panels: ScenePanel[]): 'ok' | 'truncated' {
  const truncated = panels.some((panel) =>
    (panel.text?.lines ?? []).some((line) => line.includes('Preview truncated for stability.') || line.includes('[Truncated]'))
  );
  return truncated ? 'truncated' : 'ok';
}

function panelToText(panel: ScenePanel): string {
  const lines: string[] = [`== ${panel.title} ==`];
  if (panel.status) {
    lines.push(`[${panel.status}]`);
  }

  if (panel.kind === 'stats' && panel.stats) {
    for (const stat of panel.stats) {
      lines.push(`${stat.label}: ${stat.value}`);
    }
  }

  if (panel.kind === 'table' && panel.table) {
    lines.push(panel.table.columns.join(' | '));
    lines.push('-'.repeat(Math.min(100, panel.table.columns.join(' | ').length)));
    for (const row of panel.table.rows.slice(0, 20)) {
      lines.push(row.map((cell) => String(cell)).join(' | '));
    }
    if (panel.table.rows.length > 20) {
      lines.push(`... ${panel.table.rows.length - 20} more rows`);
    }
  }

  if (panel.kind === 'text' && panel.text) {
    lines.push(...panel.text.lines);
  }

  return lines.join('\n');
}

export function renderFrameAsText(frame: HeadlessFrame): string {
  const sections: string[] = [];
  sections.push(frame.logo);
  sections.push(`Contract: ${frame.schemaVersion}`);
  sections.push(`Session: ${frame.sessionId} #${frame.sequence}`);
  sections.push(`Screen: ${frame.screen}`);
  sections.push(`Title: ${frame.title}`);
  sections.push(`Status: ${frame.status}`);
  sections.push(`Tenant: ${frame.tenantId ?? 'none'}`);
  sections.push(`Motion: ${frame.motionEnabled ? 'on' : 'off'} (phase=${frame.motionPhase})`);

  for (const panel of frame.panels) {
    sections.push(panelToText(panel));
  }

  return sections.join('\n\n');
}

async function resolveTenantId(profileStore: ProfileStore, explicitTenantId?: string): Promise<string | undefined> {
  if (explicitTenantId) {
    return explicitTenantId;
  }
  return (await profileStore.getData()).activeTenantId;
}

function buildSetupFrame(args: {
  sessionId: string;
  sequence: number;
  readiness: ReadinessCheck;
  motionEnabled: boolean;
  motionPhase: number;
  redirectedFrom?: TuiScreenId;
}): HeadlessFrame {
  const panels = sceneFromSetupState({
    tenantId: args.readiness.tenantId,
    readinessState: args.readiness.state,
    connectionState: args.readiness.connectionState,
    missingItems: args.readiness.missingItems,
    recommendedActions: args.readiness.recommendedActions,
    providerRows: toSetupProviderRows(args.readiness.providers)
  });
  return createHeadlessFrame({
    sessionId: args.sessionId,
    sequence: args.sequence,
    screen: 'setup',
    title: 'Setup',
    status: args.readiness.state === 'ready' ? 'Setup complete' : 'Setup required',
    tenantId: args.readiness.tenantId,
    motionEnabled: args.motionEnabled,
    motionPhase: args.motionPhase,
    logo: XYTE_LOGO_COMPACT,
    panels,
    meta: {
      ...withNavigationMeta('setup', {
        renderSafety: inferRenderSafety(panels),
        readiness: args.readiness.state,
        connection: args.readiness.connectivity,
        blocking: args.readiness.state !== 'ready',
        redirectedFrom: args.redirectedFrom,
        refreshState: getRefreshState({
          connectionState: args.readiness.connectionState,
          retried: false
        })
      })
    }
  });
}

async function buildConfigFrame(args: {
  sessionId: string;
  sequence: number;
  profileStore: ProfileStore;
  secretStore: SecretStore;
  readiness: ReadinessCheck;
  motionEnabled: boolean;
  motionPhase: number;
  doctorStatus?: string;
}): Promise<HeadlessFrame> {
  const { providerRows, selectedProvider, slotRows } = await readConfigData(
    args.profileStore,
    args.secretStore,
    args.readiness.tenantId
  );

  const panels = sceneFromConfigState({
    tenantId: args.readiness.tenantId,
    providerRows,
    selectedProvider,
    slotRows,
    selectedSlot: slotRows.find((row) => row.active === 'yes') ?? slotRows[0],
    doctorStatus: args.doctorStatus
  });

  return createHeadlessFrame({
    sessionId: args.sessionId,
    sequence: args.sequence,
    screen: 'config',
    title: 'Config',
    status: 'Config snapshot',
    tenantId: args.readiness.tenantId,
    motionEnabled: args.motionEnabled,
    motionPhase: args.motionPhase,
    logo: XYTE_LOGO_COMPACT,
    panels,
    meta: {
      ...withNavigationMeta('config', {
        renderSafety: inferRenderSafety(panels),
        readiness: args.readiness.state,
        connection: args.readiness.connectivity,
        blocking: false,
        refreshState: getRefreshState({
          connectionState: args.readiness.connectionState,
          retried: false
        })
      })
    }
  });
}

interface ScreenLoadResult {
  panels: ScenePanel[];
  connectionState: ConnectionState;
  error?: { message: string };
  retry: unknown;
  extraMeta?: Record<string, unknown>;
}

function buildFrameFromLoad(
  options: {
    sessionId: string;
    sequence: number;
    tenantId?: string;
    motionEnabled: boolean;
    motionPhase: number;
    readiness: ReadinessCheck;
  },
  screen: TuiScreenId,
  title: string,
  load: ScreenLoadResult
): HeadlessFrame {
  return createHeadlessFrame({
    sessionId: options.sessionId,
    sequence: options.sequence,
    screen,
    title,
    status: load.error ? `${title} ${load.connectionState}: ${load.error.message}` : `${title} snapshot`,
    tenantId: options.tenantId,
    motionEnabled: options.motionEnabled,
    motionPhase: options.motionPhase,
    logo: XYTE_LOGO_COMPACT,
    panels: load.panels,
    meta: {
      ...withNavigationMeta(screen, {
        renderSafety: inferRenderSafety(load.panels),
        readiness: options.readiness.state,
        connection: {
          state: load.connectionState,
          error: load.error?.message
        },
        actionsHint: 'interactive-only writes (organization-only)',
        writePolicy: 'organization-only',
        headlessWrite: false,
        retry: load.retry,
        refreshState: getRefreshState({
          connectionState: load.connectionState,
          retried: (load.retry as { retried?: boolean })?.retried
        }),
        ...load.extraMeta
      })
    }
  });
}

async function buildOperationalFrame(options: {
  sessionId: string;
  sequence: number;
  client: XyteClient;
  screen: Exclude<TuiScreenId, 'setup' | 'config'>;
  tenantId?: string;
  motionEnabled: boolean;
  motionPhase: number;
  readiness: ReadinessCheck;
}): Promise<HeadlessFrame> {
  switch (options.screen) {
    case 'dashboard': {
      const data = await loadDashboardData(options.client, options.tenantId);
      const panels = sceneFromDashboardState({
        tenantId: options.tenantId,
        devices: data.data.devices,
        incidents: data.data.incidents,
        tickets: data.data.tickets
      });
      return buildFrameFromLoad(options, 'dashboard', 'Dashboard', {
        panels,
        connectionState: data.connectionState,
        error: data.error,
        retry: data.retry
      });
    }

    case 'devices': {
      const devices = await loadDevicesData(options.client, options.tenantId);
      const panels = sceneFromDevicesState({
        tenantId: options.tenantId,
        searchText: '',
        selectedIndex: 0,
        devices: devices.data,
        spaceFilter: '',
        actionsHint: 'interactive-only: a send-command, f space_id filter'
      });
      return buildFrameFromLoad(options, 'devices', 'Devices', {
        panels,
        connectionState: devices.connectionState,
        error: devices.error,
        retry: devices.retry
      });
    }

    case 'incidents': {
      const incidents = await loadIncidentsData(options.client, options.tenantId);
      const panels = sceneFromIncidentsState({
        tenantId: options.tenantId,
        incidents: incidents.data,
        selectedIndex: 0,
        severityFilter: '',
        statusFilter: 'active',
        page: 1,
        perPage: 100,
        actionsHint: 'interactive-only: a close-incident, f filters, [ ] pages, p per-page'
      });
      return buildFrameFromLoad(options, 'incidents', 'Incidents', {
        panels,
        connectionState: incidents.connectionState,
        error: incidents.error,
        retry: incidents.retry
      });
    }

    case 'tickets': {
      const tickets = await loadTicketsData(options.client, options.tenantId);
      const panels = sceneFromTicketsState({
        tenantId: options.tenantId,
        mode: tickets.data.mode,
        searchText: '',
        selectedIndex: 0,
        tickets: tickets.data.tickets,
        page: 1,
        perPage: 25,
        totalFiltered: tickets.data.tickets.length,
        actionsHint: tickets.data.mode === 'organization'
          ? 'interactive-only: a resolve/message, f local filters, [ ] pages, p per-page'
          : 'interactive-only: ticket writes disabled in partner mode'
      });
      return buildFrameFromLoad(options, 'tickets', 'Tickets', {
        panels,
        connectionState: tickets.connectionState,
        error: tickets.error,
        retry: tickets.retry
      });
    }

    case 'spaces': {
      const spaces = await loadSpacesData(options.client, options.tenantId);
      const selected = spaces.data[0];
      const selectedSpaceId = selected ? getSpaceId(selected) : '';
      let detail: unknown;
      let devicesInSpace: unknown[] = [];
      let paneStatus = selected ? 'Loading selected space...' : 'No spaces found for tenant.';
      let drilldownError: string | undefined;
      let drilldownRetry: unknown;

      if (selected && selectedSpaceId) {
        const drilldown = await loadSpaceDrilldownData(options.client, options.tenantId, selectedSpaceId, []);
        detail = drilldown.data.spaceDetail;
        devicesInSpace = drilldown.data.devicesInSpace;
        paneStatus = drilldown.data.paneStatus;
        drilldownError = drilldown.error?.message;
        drilldownRetry = drilldown.retry;
      }

      const panels = sceneFromSpacesState({
        tenantId: options.tenantId,
        searchText: '',
        selectedIndex: 0,
        loading: false,
        paneStatus,
        spaces: spaces.data,
        spaceDetail: detail,
        devicesInSpace,
        endpointFilterSummary: '',
        actionsHint: 'interactive-only: a claim/create/rename, f endpoint filters'
      });
      return buildFrameFromLoad(options, 'spaces', 'Spaces', {
        panels,
        connectionState: spaces.connectionState,
        error: spaces.error,
        retry: { spaces: spaces.retry, drilldown: drilldownRetry },
        extraMeta: { connection: { state: spaces.connectionState, error: spaces.error?.message, drilldownError } }
      });
    }

  }
}

function writeFrame(write: SafeWrite, frame: HeadlessFrame) {
  write(`${JSON.stringify(frame)}\n`);
}

function writeStartup(
  write: SafeWrite,
  _format: 'json',
  motionEnabled: boolean,
  sessionId: string,
  nextSequence: () => number
) {
  const frames = startupFrames();
  frames.forEach((frame, index) => {
    const startupFrame = createHeadlessFrame({
      sessionId,
      sequence: nextSequence(),
      screen: 'setup',
      title: frame.title,
      status: frame.status,
      motionEnabled,
      motionPhase: index,
      logo: frame.banner,
      panels: [],
      meta: {
        ...withNavigationMeta('setup', {
          startup: true,
          inputState: 'idle',
          queueDepth: 0,
          droppedEvents: 0,
          transitionState: 'idle',
          refreshState: 'idle'
        })
      }
    });
    write(`${JSON.stringify(startupFrame)}\n`);
  });
}

export async function runHeadlessRenderer(options: HeadlessRenderOptions): Promise<void> {
  const output = options.output ?? process.stdout;
  const intervalMs = Math.max(250, options.intervalMs ?? 2000);
  const sessionId = randomUUID();
  let sequence = 0;
  const nextSequence = () => {
    const current = sequence;
    sequence += 1;
    return current;
  };
  let brokenPipe = false;
  let streamError: unknown;

  const write: SafeWrite = (text) => {
    if (brokenPipe || streamError) {
      return false;
    }

    try {
      output.write(text);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
        brokenPipe = true;
        return false;
      }
      throw error;
    }
  };

  const stream = output as unknown as Partial<Pick<NodeJS.WritableStream, 'on' | 'off' | 'removeListener'>>;
  const keepListener = output === process.stdout || output === process.stderr;
  const onStreamError = (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
      brokenPipe = true;
      return;
    }
    streamError = error;
  };
  const attachErrorListener = typeof stream.on === 'function';
  if (attachErrorListener) {
    stream.on?.('error', onStreamError);
  }

  writeStartup(write, options.format, options.motionEnabled, sessionId, nextSequence);

  let phase = 0;
  let running = true;
  const stop = () => {
    running = false;
  };

  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  try {
    do {
      if (streamError) {
        throw streamError;
      }

      if (brokenPipe) {
        break;
      }

      const tenantId = await resolveTenantId(options.profileStore, options.tenantId);
      const readiness = await evaluateReadiness({
        profileStore: options.profileStore,
        secretStore: options.secretStore,
        tenantId,
        client: options.client,
        checkConnectivity: true
      });

      const requestedScreen = options.screen;
      const blocked = readiness.state !== 'ready' && !['setup', 'config'].includes(requestedScreen);
      const actualScreen: TuiScreenId = blocked ? 'setup' : requestedScreen;

      let frame: HeadlessFrame;
      if (actualScreen === 'setup') {
        frame = buildSetupFrame({
          sessionId,
          sequence: nextSequence(),
          readiness,
          motionEnabled: options.motionEnabled,
          motionPhase: phase,
          redirectedFrom: blocked ? requestedScreen : undefined
        });
      } else if (actualScreen === 'config') {
        frame = await buildConfigFrame({
          sessionId,
          sequence: nextSequence(),
          profileStore: options.profileStore,
          secretStore: options.secretStore,
          readiness,
          motionEnabled: options.motionEnabled,
          motionPhase: phase,
          doctorStatus: `${readiness.connectionState}: ${readiness.connectivity.message}`
        });
      } else {
        frame = await buildOperationalFrame({
          sessionId,
          sequence: nextSequence(),
          client: options.client,
          screen: actualScreen as Exclude<TuiScreenId, 'setup' | 'config'>,
          tenantId,
          motionEnabled: options.motionEnabled,
          motionPhase: phase,
          readiness
        });
      }

      writeFrame(write, frame);
      if (brokenPipe) {
        break;
      }

      phase += 1;

      if (!options.follow) {
        break;
      }

      if (readiness.connectivity.retriable && readiness.connectivity.state !== 'connected') {
        const retryFrame = createHeadlessFrame({
          sessionId,
          sequence: nextSequence(),
          screen: 'setup',
          title: 'Reconnect',
          status: `Retrying connectivity in ${intervalMs}ms`,
          tenantId: readiness.tenantId,
          motionEnabled: options.motionEnabled,
          motionPhase: phase,
          logo: XYTE_LOGO_COMPACT,
          panels: sceneFromSetupState({
            tenantId: readiness.tenantId,
            readinessState: readiness.state,
            connectionState: readiness.connectionState,
            missingItems: readiness.missingItems,
            recommendedActions: readiness.recommendedActions,
            providerRows: toSetupProviderRows(readiness.providers)
          }),
          meta: {
            ...withNavigationMeta('setup', {
              readiness: readiness.state,
              connection: readiness.connectivity,
              retry: {
                attempt: phase,
                nextDelayMs: intervalMs
              },
              refreshState: 'retrying'
            })
          }
        });
        writeFrame(write, retryFrame);
        phase += 1;
      }

      await delay(intervalMs);
    } while (running);
  } finally {
    if (attachErrorListener && !keepListener) {
      if (typeof stream.off === 'function') {
        stream.off?.('error', onStreamError);
      } else if (typeof stream.removeListener === 'function') {
        stream.removeListener?.('error', onStreamError);
      }
    }

    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
