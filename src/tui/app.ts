import blessed from 'blessed';
import { setTimeout as delay } from 'node:timers/promises';

import { createLayout } from './layout';
import { GLOBAL_KEYMAP, SCREEN_ACTION_KEYMAP, SCREEN_INLINE_HINTS } from './keymap';
import type { TuiChoiceItem, TuiContext, TuiScreen, TuiScreenId } from './types';
import { createSetupScreen } from './screens/setup';
import { createConfigScreen } from './screens/config';
import { createDashboardScreen } from './screens/dashboard';
import { createSpacesScreen } from './screens/spaces';
import { createDevicesScreen } from './screens/devices';
import { createIncidentsScreen } from './screens/incidents';
import { createTicketsScreen } from './screens/tickets';
import type { XyteClient } from '../types/client';
import type { ProfileStore } from '../secure/profile-store';
import { FileProfileStore } from '../secure/profile-store';
import { createSecretStore, type SecretStore } from '../secure/secret-store';
import { dispatchKeypress } from './dispatch';
import { isMotionEnabled, startupFrames } from './animation';
import { runHeadlessRenderer } from './headless-renderer';
import { xyteLogoText } from './assets/logo';
import { evaluateReadiness, type ReadinessCheck } from '../config/readiness';
import { createInputController } from './input-controller';
import { ScreenRuntime, type ScreenRuntimeStatus } from './runtime';
import { createTuiLogger } from './logger';
import { nextTab } from './tabs';

interface TuiAppOptions {
  client: XyteClient;
  profileStore?: ProfileStore;
  secretStore?: SecretStore;
  initialScreen?: TuiScreenId;
  headless?: boolean;
  format?: 'json' | 'text';
  motionEnabled?: boolean;
  follow?: boolean;
  intervalMs?: number;
  tenantId?: string;
  output?: Pick<typeof process.stdout, 'write'>;
  debug?: boolean;
  debugLogPath?: string;
}

const SCREEN_TITLE_LABELS: Record<TuiScreenId, string> = {
  setup: 'Setup',
  config: 'Config',
  dashboard: 'Dashboard',
  spaces: 'Spaces',
  devices: 'Devices',
  incidents: 'Incidents',
  tickets: 'Tickets'
};

const PANE_LABELS: Record<string, string> = {
  'providers-table': 'Providers',
  'slots-table': 'Key Slots',
  'actions-box': 'Actions',
  'checklist-box': 'Checklist',
  'kpi': 'KPIs',
  'provider': 'Provider Status',
  'incidents': 'Recent Incidents',
  'tickets': 'Recent Tickets',
  'spaces-table': 'Spaces',
  'detail-box': 'Details',
  'devices-table': 'Devices'
};

function formatPaneLabel(pane: string | undefined): string {
  if (!pane) {
    return 'n/a';
  }
  return PANE_LABELS[pane] ?? pane.replace(/[-_]+/g, ' ');
}

function screenFromShortcut(ch: string | undefined): TuiScreenId | undefined {
  switch (ch) {
    case '1':
    case 'u':
      return 'setup';
    case '2':
    case 'g':
      return 'config';
    case '3':
    case 'd':
      return 'dashboard';
    case '4':
    case 's':
      return 'spaces';
    case '5':
    case 'v':
      return 'devices';
    case '6':
    case 'i':
      return 'incidents';
    case '7':
    case 't':
      return 'tickets';
    default:
      return undefined;
  }
}

function toErrorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function renderStartupSequence(
  screen: blessed.Widgets.Screen,
  messageBox: blessed.Widgets.MessageElement,
  motionEnabled: boolean
): Promise<void> {
  const frames = startupFrames();

  if (!motionEnabled) {
    const frame = frames[frames.length - 1];
    messageBox.display(`${frame.banner}\n\n${frame.status}`, 1, () => undefined);
    screen.render();
    return;
  }

  for (const frame of frames) {
    messageBox.display(`${frame.banner}\n\n${frame.status}`, 1, () => undefined);
    screen.render();
    await delay(180);
  }
}

function canOpenScreen(id: TuiScreenId, readiness: ReadinessCheck | undefined): boolean {
  if (id === 'setup' || id === 'config') {
    return true;
  }
  return readiness?.state === 'ready';
}

interface ErrorStormState {
  message: string;
  count: number;
  startedAt: number;
}

export function updateErrorStormState(
  state: ErrorStormState,
  message: string,
  now = Date.now(),
  windowMs = 2_000
): ErrorStormState {
  if (state.message === message && now - state.startedAt <= windowMs) {
    return {
      message,
      count: state.count + 1,
      startedAt: state.startedAt
    };
  }

  return {
    message,
    count: 1,
    startedAt: now
  };
}

export async function runTuiApp(options: TuiAppOptions): Promise<void> {
  const profileStore = options.profileStore ?? new FileProfileStore();
  const secretStore = options.secretStore ?? (await createSecretStore());
  const motionEnabled = isMotionEnabled({ headless: options.headless, explicitMotion: options.motionEnabled });
  const debugEnabled = Boolean(
    options.debug || options.debugLogPath || process.env.XYTE_TUI_DEBUG === '1' || process.env.XYTE_TUI_DEBUG_LOG
  );
  const logger = createTuiLogger({
    enabled: debugEnabled,
    path: options.debugLogPath ?? process.env.XYTE_TUI_DEBUG_LOG
  });
  logger.log('app.start', {
    headless: Boolean(options.headless),
    screen: options.initialScreen ?? 'dashboard',
    format: options.format ?? 'json',
    tenantId: options.tenantId,
    motionEnabled
  });

  if (options.headless) {
    const requestedFormat = options.format ?? 'json';
    if (requestedFormat !== 'json') {
      throw new Error('Headless mode only supports JSON output.');
    }
    try {
      await runHeadlessRenderer({
        client: options.client,
        profileStore,
        secretStore,
        screen: options.initialScreen ?? 'dashboard',
        format: 'json',
        motionEnabled,
        follow: options.follow,
        intervalMs: options.intervalMs,
        tenantId: options.tenantId,
        output: options.output
      });
      logger.log('app.headless.complete');
    } finally {
      logger.close();
    }
    return;
  }

  try {
    await new Promise<void>((resolve) => {
    const screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      title: 'XYTE SDK TUI'
    });

    const layout = createLayout(screen, { motionEnabled });
    let activeScreenId: TuiScreenId = options.initialScreen ?? 'dashboard';
    let pulsePhase = 0;
    let readinessState: ReadinessCheck | undefined;
    let isPromptActive = false;
    let isMessageActive = false;
    let isChooserActive = false;
    let isShuttingDown = false;
    let mountTransitionToken = 0;
    let transitionState: 'idle' | 'switching' = 'idle';
    let mountedRuntime: ScreenRuntime | undefined;
    let runtimeStatus: ScreenRuntimeStatus = {
      state: 'idle',
      refreshInFlight: false,
      refreshQueued: false,
      staleDiscarded: 0
    };
    let footerStatusText = 'Ready';
    let getInputState = () => ({ queueDepth: 0, droppedEvents: 0, inFlight: false });
    let lastRuntimeLogLine = '';
    let lastRenderCounter = 0;
    let isHandlingFatalError = false;
    let errorStormState: ErrorStormState = {
      message: '',
      count: 0,
      startedAt: 0
    };

    logger.log('app.interactive.start', {
      initialScreen: activeScreenId,
      motionEnabled
    });

    const renderRouteBar = () => {
      const trail = mounted?.getNavigationTrail?.();
      layout.setRouteText(
        (trail && trail.length ? trail : [SCREEN_TITLE_LABELS[activeScreenId], formatPaneLabel(mounted?.getActivePane?.())]).join(
          ' > '
        )
      );
    };

    const renderHelpBar = () => {
      const pane = mounted?.getActivePane?.();
      const paneLabel = formatPaneLabel(pane);
      const screenHint = SCREEN_INLINE_HINTS[activeScreenId];
      layout.setHelpText(`${SCREEN_TITLE_LABELS[activeScreenId]} • pane ${paneLabel} • ${screenHint}`);
    };

    const renderFooter = (statusText?: string) => {
      if (statusText !== undefined) {
        footerStatusText = statusText;
      }

      const pane = formatPaneLabel(mounted?.getActivePane?.());
      const readiness = readinessState
        ? `${readinessState.state} / ${readinessState.connectionState} / tenant ${readinessState.tenantId ?? 'none'}`
        : 'status unknown';
      const segments = [
        `screen ${SCREEN_TITLE_LABELS[activeScreenId]}`,
        `pane ${pane}`,
        readiness,
        footerStatusText
      ];
      if (runtimeStatus.lastError) {
        segments.push(`last error ${runtimeStatus.lastError}`);
      }
      if (debugEnabled) {
        const inputState = getInputState();
        segments.push(
          `dbg refresh=${runtimeStatus.state}${runtimeStatus.refreshQueued ? '+queued' : ''}`,
          `q=${inputState.queueDepth}`,
          `drop=${inputState.droppedEvents}`,
          `tx=${transitionState}`
        );
      }
      layout.setFooterText(segments.join(' | '));
      renderRouteBar();
      renderHelpBar();
      screen.render();
    };

    const message = blessed.message({
      parent: screen,
      border: 'line',
      width: '70%',
      height: 'shrink',
      top: 'center',
      left: 'center',
      label: ' XYTE ',
      tags: true,
      hidden: true
    });

    const promptWidget = blessed.prompt({
      parent: screen,
      border: 'line',
      width: '70%',
      height: 'shrink',
      top: 'center',
      left: 'center',
      label: ' Input ',
      tags: true,
      hidden: true
    });

    const chooserBox = blessed.box({
      parent: screen,
      border: 'line',
      width: '72%',
      height: '70%',
      top: 'center',
      left: 'center',
      label: ' Choose ',
      hidden: true,
      style: {
        border: { fg: 'blue' }
      }
    });

    const chooserList = blessed.list({
      parent: chooserBox,
      top: 0,
      left: 0,
      width: '100%-2',
      height: '100%-3',
      border: 'line',
      label: ' Options ',
      keys: true,
      mouse: true,
      vi: true,
      tags: true,
      style: {
        border: { fg: 'blue' },
        item: { fg: 'white' },
        selected: { fg: 'white', bg: 'blue', bold: true }
      },
      hidden: false
    });

    const chooserHelp = blessed.box({
      parent: chooserBox,
      bottom: 0,
      left: 0,
      width: '100%-2',
      height: 1,
      content: ' ↑/↓ move | Enter select | 1-9 quick pick | Esc cancel ',
      style: {
        fg: 'cyan'
      }
    });

    const setMessageModalState = (active: boolean) => {
      isMessageActive = active;
    };

    let chooserItems: TuiChoiceItem[] = [];
    let chooserResolve: ((value: number | undefined) => void) | undefined;
    let chooserPreviousFocus: { focus: () => void } | undefined;

    const closeChooser = (value: number | undefined) => {
      if (!isChooserActive) {
        return;
      }
      isChooserActive = false;
      chooserBox.hide();
      const resolveChoice = chooserResolve;
      chooserResolve = undefined;
      chooserItems = [];
      chooserPreviousFocus?.focus();
      chooserPreviousFocus = undefined;
      screen.render();
      resolveChoice?.(value);
    };

    chooserList.on('select item', (_item: unknown, index: number) => {
      const selectedIndex = Number(index);
      const item = chooserItems[selectedIndex];
      if (!item) {
        closeChooser(undefined);
        return;
      }
      if (item.disabled) {
        renderFooter(item.disabledReason ?? `${item.label} is disabled.`);
        return;
      }
      closeChooser(selectedIndex);
    });

    chooserList.key(['escape'], () => {
      closeChooser(undefined);
    });

    chooserList.on('keypress', (ch: string | undefined) => {
      if (!ch || !/^[1-9]$/.test(ch)) {
        return;
      }
      const selectedIndex = Number(ch) - 1;
      if (selectedIndex < 0 || selectedIndex >= chooserItems.length) {
        return;
      }
      const item = chooserItems[selectedIndex];
      if (item.disabled) {
        renderFooter(item.disabledReason ?? `${item.label} is disabled.`);
        return;
      }
      closeChooser(selectedIndex);
    });

    const runChooser = (args: { title: string; items: TuiChoiceItem[]; initialIndex?: number }): Promise<number | undefined> => {
      if (!args.items.length) {
        return Promise.resolve(undefined);
      }

      chooserItems = args.items;
      chooserBox.setLabel(` ${args.title} `);
      chooserHelp.setContent(' ↑/↓ move | Enter select | 1-9 quick pick | Esc cancel ');
      chooserList.setItems(
        args.items.map((item, index) => {
          const number = `${index + 1}.`;
          const detail = item.hint ? ` {gray-fg}${item.hint}{/gray-fg}` : '';
          if (item.disabled) {
            return `{gray-fg}${number} ${item.label} (disabled){/gray-fg}${detail}`;
          }
          return `${number} ${item.label}${detail}`;
        })
      );
      const firstEnabledIndex = args.items.findIndex((item) => !item.disabled);
      const fallbackIndex = firstEnabledIndex >= 0 ? firstEnabledIndex : 0;
      const initialIndex = Math.max(0, Math.min(args.initialIndex ?? fallbackIndex, Math.max(args.items.length - 1, 0)));
      chooserPreviousFocus = screen.focused as { focus: () => void } | undefined;
      chooserList.select(initialIndex);
      chooserBox.show();
      isChooserActive = true;
      chooserList.focus();
      screen.render();

      return new Promise((resolveChoice) => {
        chooserResolve = resolveChoice;
      });
    };

    const writeErrorStderr = (source: string, messageText: string) => {
      try {
        process.stderr.write(`[xyte-tui] ${source}: ${messageText}\n`);
      } catch {
        // best-effort stderr logging
      }
    };

    const runPrompt = (promptText: string, initial = '', secret = false): Promise<string | undefined> => {
      const promptInternals = promptWidget as unknown as {
        _: {
          input?: {
            censor?: boolean;
            secret?: boolean;
          };
        };
      };
      const input = promptInternals._?.input;
      const prevCensor = input?.censor;
      const prevSecret = input?.secret;
      if (input) {
        input.censor = secret;
        input.secret = false;
      }
      isPromptActive = true;
      logger.log('prompt.open', {
        promptText,
        secret,
        hasInitial: Boolean(initial)
      });

      return new Promise((resolvePrompt) => {
        promptWidget.input(promptText, initial, (_err, value) => {
          if (input) {
            input.censor = prevCensor;
            input.secret = prevSecret;
          }
          isPromptActive = false;
          logger.log('prompt.close', {
            promptText,
            secret,
            hasValue: value !== undefined && value !== null && String(value).length > 0
          });
          screen.render();
          resolvePrompt(value ?? undefined);
        });
      });
    };

    const refreshReadiness = async (checkConnectivity = false): Promise<ReadinessCheck> => {
      logger.log('readiness.refresh.start', { checkConnectivity });
      readinessState = await evaluateReadiness({
        profileStore,
        secretStore,
        tenantId: options.tenantId,
        client: options.client,
        checkConnectivity
      });
      logger.log('readiness.refresh.complete', {
        state: readinessState.state,
        connectionState: readinessState.connectionState,
        tenantId: readinessState.tenantId
      });
      renderFooter();
      return readinessState;
    };

    let shutdownRef: (() => void) | undefined;
    const safeShowError = (source: string, error: unknown) => {
      const text = toErrorText(error);
      logger.log('ui.error.safe', {
        source,
        message: text,
        error
      });
      if (isShuttingDown) {
        writeErrorStderr(source, text);
        return;
      }

      const now = Date.now();
      errorStormState = updateErrorStormState(errorStormState, text, now);
      if (errorStormState.count >= 5) {
        logger.log('ui.error.storm', {
          source,
          message: text,
          count: errorStormState.count
        });
        writeErrorStderr(source, `error storm detected (${errorStormState.count} in 2s): ${text}`);
        shutdownRef?.();
        return;
      }

      runtimeStatus = {
        ...runtimeStatus,
        state: 'error',
        lastError: text
      };
      renderFooter(`Error: ${text}`);

      if (isHandlingFatalError) {
        logger.log('ui.error.reentrant', {
          source,
          message: text
        });
        writeErrorStderr(source, text);
        return;
      }

      isHandlingFatalError = true;
      setMessageModalState(true);
      try {
        message.display(`{red-fg}Error{/red-fg}: ${text}`, 4, () => {
          setMessageModalState(false);
          isHandlingFatalError = false;
          try {
            screen.render();
          } catch (renderError) {
            logger.log('ui.error.render.failure', {
              source,
              original: text,
              renderError
            });
            writeErrorStderr(source, `render failure after error modal: ${toErrorText(renderError)}`);
            shutdownRef?.();
          }
        });
      } catch (displayError) {
        isHandlingFatalError = false;
        setMessageModalState(false);
        logger.log('ui.error.display.failure', {
          source,
          original: text,
          displayError
        });
        writeErrorStderr(source, `unable to display error modal: ${toErrorText(displayError)} | original: ${text}`);
        shutdownRef?.();
      }
    };

    const context: TuiContext = {
      screen,
      client: options.client,
      profileStore,
      secretStore,
      async getActiveTenantId() {
        return options.tenantId ?? (await profileStore.getData()).activeTenantId;
      },
      getReadiness() {
        return readinessState;
      },
      async refreshReadiness(checkConnectivity = false) {
        return refreshReadiness(checkConnectivity);
      },
      setStatus(text) {
        renderFooter(text);
      },
      showError(error) {
        safeShowError('context.showError', error);
      },
      debugLog(event, data) {
        logger.log(event, data);
      },
      prompt(promptText, initial = '') {
        return runPrompt(promptText, initial, false);
      },
      promptSecret(promptText, initial = '') {
        return runPrompt(promptText, initial, true);
      },
      choose(args) {
        return runChooser(args);
      },
      async confirmWrite(actionLabel, token) {
        const value = await context.prompt(`Type "${token}" to confirm: ${actionLabel}`, '');
        return value === token;
      },
      async switchScreen(screenId) {
        await mountScreen(screenId);
      }
    };

    const screens: Record<TuiScreenId, TuiScreen> = {
      setup: createSetupScreen(),
      config: createConfigScreen(),
      dashboard: createDashboardScreen(),
      spaces: createSpacesScreen(),
      devices: createDevicesScreen(),
      incidents: createIncidentsScreen(),
      tickets: createTicketsScreen()
    };

    let mounted: TuiScreen | undefined;

    const mountScreen = async (id: TuiScreenId) => {
      const token = ++mountTransitionToken;
      transitionState = 'switching';
      logger.log('screen.mount.request', {
        requested: id,
        token
      });
      renderFooter(`Switching to ${id}...`);

      const nextId = canOpenScreen(id, readinessState) ? id : 'setup';
      if (nextId !== id) {
        logger.log('screen.mount.redirect', {
          requested: id,
          redirectedTo: nextId,
          readinessState: readinessState?.state
        });
        renderFooter(`Setup required before opening ${id}. Redirected to Setup.`);
      }

      mountedRuntime?.cancelPendingForUnmount();
      mountedRuntime = undefined;

      if (mounted) {
        logger.log('screen.unmount', {
          id: mounted.id
        });
        mounted.unmount();
      }

      const next = screens[nextId];
      next.mount(layout.body, context);
      activeScreenId = nextId;
      mounted = next;

      mountedRuntime = new ScreenRuntime({
        refresh: async () => {
          if (token !== mountTransitionToken || isShuttingDown) {
            logger.log('screen.refresh.skip', {
              id: nextId,
              token,
              latestToken: mountTransitionToken,
              isShuttingDown
            });
            return;
          }
          logger.log('screen.refresh.start', {
            id: nextId,
            reason: runtimeStatus.reason
          });
          await next.refresh();
          logger.log('screen.refresh.complete', {
            id: nextId
          });
        },
        onStatus(status) {
          runtimeStatus = status;
          const statusLine = JSON.stringify(status);
          if (statusLine !== lastRuntimeLogLine) {
            lastRuntimeLogLine = statusLine;
            logger.log('screen.runtime.status', {
              id: nextId,
              ...status
            });
          }
          renderFooter();
        },
        onError(error) {
          logger.log('screen.runtime.error', {
            id: nextId,
            error
          });
          safeShowError('screen.runtime', error);
        }
      });
      mountedRuntime.setMountToken(token);
      runtimeStatus = mountedRuntime.getStatus();

      layout.setActiveTab(nextId);
      layout.setHeaderTitle(next.title);
      transitionState = 'idle';
      next.focus?.();
      logger.log('screen.mount.active', {
        id: nextId,
        token
      });
      renderFooter(`Active screen: ${next.title}`);
      mountedRuntime.runRefresh('mount');

      void context
        .refreshReadiness(true)
        .then((nextReadiness) => {
          if (token !== mountTransitionToken || isShuttingDown) {
            return;
          }
          if (nextReadiness.state !== 'ready' && !['setup', 'config'].includes(activeScreenId)) {
            renderFooter(`Setup required before opening ${activeScreenId}. Redirected to Setup.`);
            void mountScreen('setup');
          }
        })
        .catch((error) => {
          safeShowError('screen.mount.readiness', error);
        });
    };

    const showHelp = () => {
      const content = [
        '{bold}Global shortcuts{/bold}',
        ...GLOBAL_KEYMAP.map((item) => `- ${item.keys}: ${item.description}`),
        '',
        '{bold}Screen actions{/bold}',
        ...SCREEN_ACTION_KEYMAP.map((item) => `- ${item.keys}: ${item.description}`)
      ].join('\n');

      setMessageModalState(true);
      message.display(content, 0, () => {
        setMessageModalState(false);
        screen.render();
      });
    };

    const handleGlobalKey = async (ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) => {
      logger.log('input.global', {
        key: key.name ?? key.full,
        ch,
        activeScreenId
      });
      if (key.name === 'escape' || key.name === 'backspace') {
        const wentBack = await mounted?.goBack?.();
        if (wentBack) {
          renderFooter('Back.');
          return;
        }
        renderFooter('Already at the root node. Press ? for help.');
        return;
      }
      if (key.name === 'tab' && !key.shift) {
        const target = nextTab(activeScreenId, 'right');
        await mountScreen(target);
        return;
      }
      if (key.full === 'S-tab' || (key.name === 'tab' && key.shift)) {
        const target = nextTab(activeScreenId, 'left');
        await mountScreen(target);
        return;
      }
      const shortcutTarget = screenFromShortcut(ch);
      if (shortcutTarget) {
        await mountScreen(shortcutTarget);
        return;
      }
      if (ch === 'r') {
        logger.log('screen.refresh.request', {
          id: activeScreenId,
          via: 'global-r'
        });
        mountedRuntime?.runRefresh('manual');
        void context
          .refreshReadiness(true)
          .then((nextReadiness) => {
            if (isShuttingDown) {
              return;
            }
            if (nextReadiness.state !== 'ready' && !['setup', 'config'].includes(activeScreenId)) {
              renderFooter(`Setup required before opening ${activeScreenId}. Redirected to Setup.`);
              void mountScreen('setup');
              return;
            }
            renderFooter('Screen refreshed.');
          })
          .catch((error) => {
            safeShowError('global.refresh', error);
          });
        return;
      }

      if (ch === '?') {
        showHelp();
        return;
      }
    };

    const shutdown = () => {
      if (isShuttingDown) {
        return;
      }
      isShuttingDown = true;
      logger.log('app.shutdown.start', {
        activeScreenId
      });
      try {
        mountedRuntime?.cancelPendingForUnmount();
        mounted?.unmount();
      } finally {
        screen.destroy();
        logger.log('app.shutdown.complete');
        resolve();
      }
    };
    shutdownRef = shutdown;

    const inputController = createInputController({
      maxQueueSize: 64,
      async handle(event) {
        if (isShuttingDown) {
          return;
        }
        if (event.key.full === 'C-c' || event.ch === 'q' || event.key.name === 'q') {
          logger.log('input.critical', {
            key: event.key.name ?? event.key.full,
            full: event.key.full
          });
          shutdown();
          return;
        }

        const modalActive = isPromptActive || isMessageActive || isChooserActive;
        const safeCh = modalActive ? undefined : event.ch;
        const activeMounted = mounted;
        const dispatchResult = await dispatchKeypress({
          ch: event.ch,
          key: event.key,
          isModalActive: modalActive,
          handleArrow: activeMounted?.handleArrow
            ? async (key) => {
                try {
                  return await activeMounted.handleArrow!(key);
                } catch (error) {
                  logger.log('input.arrow.error', {
                    screen: activeMounted?.id,
                    key,
                    error
                  });
                  safeShowError('input.arrow', error);
                  return 'handled';
                }
              }
            : undefined,
          handleScreen: activeMounted?.handleKey
            ? async (ch, key) => {
                try {
                  return await activeMounted.handleKey!(ch, key);
                } catch (error) {
                  logger.log('input.screen.error', {
                    screen: activeMounted?.id,
                    key: key.name ?? key.full,
                    error
                  });
                  safeShowError('input.screen', error);
                  return true;
                }
              }
            : undefined,
          handleGlobal: async (ch, key) => {
            try {
              await handleGlobalKey(ch, key);
            } catch (error) {
              logger.log('input.global.error', {
                key: key.name ?? key.full,
                error
              });
              safeShowError('input.global', error);
            }
          }
        });
        logger.log('input.dispatch', {
          screen: activeMounted?.id,
          key: event.key.name ?? event.key.full,
          full: event.key.full,
          ch: safeCh,
          modalActive,
          result: dispatchResult,
          queueDepth: getInputState().queueDepth,
          droppedEvents: getInputState().droppedEvents
        });
        const renderCount = Number((screen as unknown as { renders?: number }).renders ?? 0);
        const renderDelta = Math.max(0, renderCount - lastRenderCounter);
        lastRenderCounter = renderCount;
        logger.log('nav.render.count', {
          screen: activeMounted?.id,
          key: event.key.name ?? event.key.full,
          renderCount,
          delta: renderDelta
        });
        renderFooter();
      },
      onError(error) {
        logger.log('input.controller.error', { error });
        safeShowError('input.controller', error);
      }
    });
    getInputState = inputController.getState;

    const onUnhandledRejection = (reason: unknown) => {
      logger.log('process.unhandledRejection', { reason });
      safeShowError('process.unhandledRejection', reason);
    };
    const onUncaughtException = (error: Error) => {
      logger.log('process.uncaughtException', { error });
      safeShowError('process.uncaughtException', error);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    process.on('uncaughtException', onUncaughtException);

    screen.on('keypress', (ch: string | undefined, key: blessed.Widgets.Events.IKeyEventArg) => {
      const dispatchResult = inputController.dispatch({
        ch,
        key,
        timestamp: Date.now()
      });
      const modalActive = isPromptActive || isMessageActive || isChooserActive;
      logger.log('input.enqueue', {
        key: key.name ?? key.full,
        ch: modalActive ? undefined : ch,
        modalActive,
        ...dispatchResult
      });
      renderFooter();
    });

    const pulseTimer = motionEnabled
      ? setInterval(() => {
          pulsePhase += 1;
          layout.setPulsePhase(pulsePhase);
          screen.render();
        }, 220)
      : undefined;

    void (async () => {
      await renderStartupSequence(screen, message, motionEnabled);
      message.hide();
      layout.setHeaderTitle(xyteLogoText().split('\n')[0]);
      const readiness = await context.refreshReadiness(true);
      if (readiness.state !== 'ready') {
        activeScreenId = 'setup';
      }
      await mountScreen(activeScreenId);
      renderFooter();
    })().catch((error) => {
      safeShowError('app.startup', error);
    });

    screen.on('destroy', () => {
      inputController.clear();
      mountedRuntime?.cancelPendingForUnmount();
      process.removeListener('unhandledRejection', onUnhandledRejection);
      process.removeListener('uncaughtException', onUncaughtException);
      if (pulseTimer) {
        clearInterval(pulseTimer);
      }
      logger.close();
    });
    });
  } finally {
    logger.close();
  }
}
