import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

import { evaluateReadiness, type ReadinessCheck } from '../config/readiness';
import type { KeychainStore } from '../secure/keychain';
import type { ProfileStore } from '../secure/profile-store';
import type { SecretProvider } from '../types/profile';
import type { XyteClient } from '../types/client';
import { startupFrames } from './animation';
import { XYTE_LOGO_COMPACT } from './assets/logo';
import {
  getSpaceId,
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
  type HeadlessFrame,
  type ScenePanel
} from './scene';
import type { TuiScreenId } from './types';
import { SCREEN_PANE_CONFIG } from './panes';
import { TAB_ORDER } from './tabs';

export interface HeadlessRenderOptions {
  client: XyteClient;
  profileStore: ProfileStore;
  keychain: KeychainStore;
  screen: TuiScreenId;
  format: 'json';
  motionEnabled: boolean;
  follow?: boolean;
  intervalMs?: number;
  tenantId?: string;
  output?: Pick<typeof process.stdout, 'write'>;
}

type SafeWrite = (text: string) => boolean;

const PROVIDERS: SecretProvider[] = ['xyte-org', 'xyte-partner', 'xyte-device'];

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

async function buildSetupFrame(args: {
  sessionId: string;
  sequence: number;
  readiness: ReadinessCheck;
  motionEnabled: boolean;
  motionPhase: number;
  redirectedFrom?: TuiScreenId;
}): Promise<HeadlessFrame> {
  const panels = sceneFromSetupState({
    tenantId: args.readiness.tenantId,
    readinessState: args.readiness.state,
    connectionState: args.readiness.connectionState,
    missingItems: args.readiness.missingItems,
    recommendedActions: args.readiness.recommendedActions,
    providerRows: args.readiness.providers.map((provider) => ({
      provider: provider.provider,
      slotCount: provider.slotCount,
      activeSlot: provider.activeSlotId ?? 'none',
      hasSecret: provider.hasActiveSecret ? 'yes' : 'no'
    }))
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
  keychain: KeychainStore;
  readiness: ReadinessCheck;
  motionEnabled: boolean;
  motionPhase: number;
  doctorStatus?: string;
}): Promise<HeadlessFrame> {
  const tenantId = args.readiness.tenantId;
  const allSlots = tenantId ? await args.profileStore.listKeySlots(tenantId) : [];

  const providerRows = await Promise.all(
    PROVIDERS.map(async (provider) => {
      const providerSlots = allSlots.filter((slot) => slot.provider === provider);
      const activeSlot = tenantId ? await args.profileStore.getActiveKeySlot(tenantId, provider) : undefined;
      const hasActiveSecret =
        tenantId && activeSlot ? Boolean(await args.keychain.getSlotSecret(tenantId, provider, activeSlot.slotId)) : false;
      return {
        provider,
        slotCount: providerSlots.length,
        activeSlot: activeSlot?.slotId ?? 'none',
        hasSecret: hasActiveSecret ? 'yes' : 'no',
        lastValidatedAt: activeSlot?.lastValidatedAt
      };
    })
  );

  const selectedProvider = providerRows.find((row) => row.slotCount > 0)?.provider ?? 'xyte-org';
  const slotRows = await Promise.all(
    allSlots
      .filter((slot) => slot.provider === selectedProvider)
      .map(async (slot) => {
        const active = tenantId ? await args.profileStore.getActiveKeySlot(tenantId, slot.provider) : undefined;
        const hasSecret = tenantId ? Boolean(await args.keychain.getSlotSecret(tenantId, slot.provider, slot.slotId)) : false;
        return {
          provider: slot.provider,
          slotId: slot.slotId,
          name: slot.name,
          active: active?.slotId === slot.slotId ? 'yes' : 'no',
          hasSecret: hasSecret ? 'yes' : 'no',
          fingerprint: slot.fingerprint
        };
      })
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
      return createHeadlessFrame({
        sessionId: options.sessionId,
        sequence: options.sequence,
        screen: 'dashboard',
        title: 'Dashboard',
        status: data.error ? `Dashboard ${data.connectionState}: ${data.error.message}` : 'Dashboard snapshot',
        tenantId: options.tenantId,
        motionEnabled: options.motionEnabled,
        motionPhase: options.motionPhase,
        logo: XYTE_LOGO_COMPACT,
        panels,
        meta: {
          ...withNavigationMeta('dashboard', {
            renderSafety: inferRenderSafety(panels),
            readiness: options.readiness.state,
            connection: {
              state: data.connectionState,
              error: data.error?.message
            },
            retry: data.retry,
            refreshState: getRefreshState({
              connectionState: data.connectionState,
              retried: data.retry.retried
            })
          })
        }
      });
    }

    case 'devices': {
      const devices = await loadDevicesData(options.client, options.tenantId);
      const panels = sceneFromDevicesState({
        tenantId: options.tenantId,
        searchText: '',
        selectedIndex: 0,
        devices: devices.data
      });
      return createHeadlessFrame({
        sessionId: options.sessionId,
        sequence: options.sequence,
        screen: 'devices',
        title: 'Devices',
        status: devices.error ? `Devices ${devices.connectionState}: ${devices.error.message}` : 'Devices snapshot',
        tenantId: options.tenantId,
        motionEnabled: options.motionEnabled,
        motionPhase: options.motionPhase,
        logo: XYTE_LOGO_COMPACT,
        panels,
        meta: {
          ...withNavigationMeta('devices', {
            renderSafety: inferRenderSafety(panels),
            readiness: options.readiness.state,
            connection: {
              state: devices.connectionState,
              error: devices.error?.message
            },
            retry: devices.retry,
            refreshState: getRefreshState({
              connectionState: devices.connectionState,
              retried: devices.retry.retried
            })
          })
        }
      });
    }

    case 'incidents': {
      const incidents = await loadIncidentsData(options.client, options.tenantId);
      const panels = sceneFromIncidentsState({
        tenantId: options.tenantId,
        incidents: incidents.data,
        selectedIndex: 0,
        severityFilter: ''
      });
      return createHeadlessFrame({
        sessionId: options.sessionId,
        sequence: options.sequence,
        screen: 'incidents',
        title: 'Incidents',
        status: incidents.error ? `Incidents ${incidents.connectionState}: ${incidents.error.message}` : 'Incidents snapshot',
        tenantId: options.tenantId,
        motionEnabled: options.motionEnabled,
        motionPhase: options.motionPhase,
        logo: XYTE_LOGO_COMPACT,
        panels,
        meta: {
          ...withNavigationMeta('incidents', {
            renderSafety: inferRenderSafety(panels),
            readiness: options.readiness.state,
            connection: {
              state: incidents.connectionState,
              error: incidents.error?.message
            },
            retry: incidents.retry,
            refreshState: getRefreshState({
              connectionState: incidents.connectionState,
              retried: incidents.retry.retried
            })
          })
        }
      });
    }

    case 'tickets': {
      const tickets = await loadTicketsData(options.client, options.tenantId);
      const panels = sceneFromTicketsState({
        tenantId: options.tenantId,
        mode: tickets.data.mode,
        searchText: '',
        selectedIndex: 0,
        tickets: tickets.data.tickets
      });
      return createHeadlessFrame({
        sessionId: options.sessionId,
        sequence: options.sequence,
        screen: 'tickets',
        title: 'Tickets',
        status: tickets.error ? `Tickets ${tickets.connectionState}: ${tickets.error.message}` : 'Tickets snapshot',
        tenantId: options.tenantId,
        motionEnabled: options.motionEnabled,
        motionPhase: options.motionPhase,
        logo: XYTE_LOGO_COMPACT,
        panels,
        meta: {
          ...withNavigationMeta('tickets', {
            renderSafety: inferRenderSafety(panels),
            readiness: options.readiness.state,
            connection: {
              state: tickets.connectionState,
              error: tickets.error?.message
            },
            retry: tickets.retry,
            refreshState: getRefreshState({
              connectionState: tickets.connectionState,
              retried: tickets.retry.retried
            })
          })
        }
      });
    }

    case 'spaces': {
      const spaces = await loadSpacesData(options.client, options.tenantId);
      const selected = spaces.data[0];
      const selectedSpaceId = selected ? getSpaceId(selected) : '';
      let detail: unknown;
      let devicesInSpace: any[] = [];
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
        devicesInSpace
      });
      return createHeadlessFrame({
        sessionId: options.sessionId,
        sequence: options.sequence,
        screen: 'spaces',
        title: 'Spaces',
        status: spaces.error ? `Spaces ${spaces.connectionState}: ${spaces.error.message}` : 'Spaces snapshot',
        tenantId: options.tenantId,
        motionEnabled: options.motionEnabled,
        motionPhase: options.motionPhase,
        logo: XYTE_LOGO_COMPACT,
        panels,
        meta: {
          ...withNavigationMeta('spaces', {
            renderSafety: inferRenderSafety(panels),
            readiness: options.readiness.state,
            connection: {
              state: spaces.connectionState,
              error: spaces.error?.message,
              drilldownError
            },
            retry: {
              spaces: spaces.retry,
              drilldown: drilldownRetry
            },
            refreshState: getRefreshState({
              connectionState: spaces.connectionState,
              retried: spaces.retry.retried
            })
          })
        }
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

  if (options.format !== 'json') {
    throw new Error('Headless renderer only supports json format.');
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
        keychain: options.keychain,
        tenantId,
        client: options.client,
        checkConnectivity: true
      });

      const requestedScreen = options.screen;
      const blocked = readiness.state !== 'ready' && !['setup', 'config'].includes(requestedScreen);
      const actualScreen: TuiScreenId = blocked ? 'setup' : requestedScreen;

      let frame: HeadlessFrame;
      if (actualScreen === 'setup') {
        frame = await buildSetupFrame({
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
          keychain: options.keychain,
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
            providerRows: readiness.providers.map((provider) => ({
              provider: provider.provider,
              slotCount: provider.slotCount,
              activeSlot: provider.activeSlotId ?? 'none',
              hasSecret: provider.hasActiveSecret ? 'yes' : 'no'
            }))
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
