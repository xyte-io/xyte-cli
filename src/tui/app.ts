import blessed from 'blessed';
import { setTimeout as delay } from 'node:timers/promises';

import { createLayout } from './layout';
import { GLOBAL_KEYMAP, SCREEN_ACTION_KEYMAP } from './keymap';
import type { TuiContext, TuiScreen, TuiScreenId } from './types';
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
import { createKeychainStore, type KeychainStore } from '../secure/keychain';
import { dispatchKeypress } from './dispatch';
import { isMotionEnabled, startupFrames } from './animation';
import { runHeadlessRenderer } from './headless-renderer';
import { xyteLogoText } from './assets/logo';
import { evaluateReadiness, type ReadinessCheck } from '../config/readiness';
import { createInputController } from './input-controller';
import { ScreenRuntime, type ScreenRuntimeStatus } from './runtime';
import { createTuiLogger } from './logger';
import { nextTab } from './tabs';

export interface TuiAppOptions {
  client: XyteClient;
  profileStore?: ProfileStore;
  keychain?: KeychainStore;
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

export interface ErrorStormState {
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
  const keychain = options.keychain ?? (await createKeychainStore());
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
        keychain,
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

    const renderFooter = (statusText?: string) => {
      if (statusText !== undefined) {
        footerStatusText = statusText;
      }

      const readiness = readinessState
        ? `${readinessState.state}/${readinessState.connectionState} tenant=${readinessState.tenantId ?? 'none'}`
        : 'status=unknown';
      const inputState = getInputState();
      const runtime = `refresh=${runtimeStatus.state}${runtimeStatus.refreshQueued ? '+queued' : ''} stale=${runtimeStatus.staleDiscarded} in=${inputState.queueDepth} drop=${inputState.droppedEvents} tx=${transitionState}`;
      const detail = runtimeStatus.lastError ? `${footerStatusText} | err=${runtimeStatus.lastError}` : footerStatusText;
      layout.footer.setContent(` @ ${readiness} | ${runtime} | ${detail}`);
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

    const setMessageModalState = (active: boolean) => {
      isMessageActive = active;
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
        keychain,
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
      keychain,
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
      async confirmWrite(actionLabel, token) {
        const value = await context.prompt(`Type "${token}" to confirm: ${actionLabel}`, '');
        return value === token;
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
      layout.header.setContent(` XYTE SDK TUI | ${next.title.toUpperCase()} `);
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
      if (key.name === 'left' || key.name === 'right') {
        const target = nextTab(activeScreenId, key.name);
        await mountScreen(target);
        return;
      }
      if (ch === 'u') {
        await mountScreen('setup');
        return;
      }
      if (ch === 'g') {
        await mountScreen('config');
        return;
      }
      if (ch === 'd') {
        await mountScreen('dashboard');
        return;
      }
      if (ch === 's') {
        await mountScreen('spaces');
        return;
      }
      if (ch === 'v') {
        await mountScreen('devices');
        return;
      }
      if (ch === 'i') {
        await mountScreen('incidents');
        return;
      }
      if (ch === 't') {
        await mountScreen('tickets');
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

      if (key.name === 'escape') {
        showHelp();
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

        const modalActive = isPromptActive || isMessageActive;
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

    screen.on('keypress', (ch, key) => {
      const dispatchResult = inputController.dispatch({
        ch,
        key,
        timestamp: Date.now()
      });
      const modalActive = isPromptActive || isMessageActive;
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
      layout.header.setContent(` XYTE SDK TUI | ${xyteLogoText().split('\n')[0]} `);
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
