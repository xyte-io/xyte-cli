import blessed from 'blessed';

import { movePaneWithBoundary, scrollBox } from '../navigation';
import { SCREEN_PANE_CONFIG } from '../panes';
import type { TuiArrowKey, TuiContext, TuiPaneId, TuiScreen } from '../types';
import { sceneFromCopilotState } from '../scene';

export function createCopilotScreen(): TuiScreen {
  let root: blessed.Widgets.BoxElement | undefined;
  let input: blessed.Widgets.TextboxElement | undefined;
  let output: blessed.Widgets.BoxElement | undefined;
  let providerBox: blessed.Widgets.BoxElement | undefined;
  let context: TuiContext;
  let logs: string[] = [];
  const paneConfig = SCREEN_PANE_CONFIG.copilot;
  let activePane: TuiPaneId = paneConfig.defaultPane;
  let isMounted = false;

  const focusPane = () => {
    if (activePane === 'prompt-input') {
      input?.focus();
      return;
    }
    if (activePane === 'provider-box') {
      providerBox?.focus();
      return;
    }
    output?.focus();
  };

  const renderScene = async () => {
    if (!isMounted) {
      return;
    }
    const tenantId = await context.getActiveTenantId();
    const override = context.getProviderOverride();
    const panels = sceneFromCopilotState({
      tenantId,
      provider: override.provider,
      model: override.model,
      logs
    });

    const providerPanel = panels.find((panel) => panel.id === 'copilot-status');
    const outputPanel = panels.find((panel) => panel.id === 'copilot-log');

      providerBox?.setContent((providerPanel?.text?.lines ?? []).join('\n'));
      output?.setContent((outputPanel?.text?.lines ?? []).join('\n\n'));
      focusPane();
      context.screen.render();
    };

  const appendOutput = async (text: string) => {
    if (!isMounted) {
      return;
    }
    logs = [...logs, text].slice(-80);
    await renderScene();
  };

  return {
    id: 'copilot',
    title: 'Copilot',
    mount(parent, ctx) {
      context = ctx;
      isMounted = true;
      root = blessed.box({
        parent,
        width: '100%-2',
        height: '100%-2'
      });

      input = blessed.textbox({
        parent: root,
        top: 0,
        left: 0,
        width: '100%',
        height: 3,
        border: 'line',
        label: ' Prompt (Enter to run) ',
        inputOnFocus: true,
        keys: true,
        mouse: true
      });

      providerBox = blessed.box({
        parent: root,
        top: 3,
        left: 0,
        width: '100%',
        height: 4,
        border: 'line',
        label: ' Provider ',
        keys: false,
        mouse: true
      });

      output = blessed.box({
        parent: root,
        top: 7,
        left: 0,
        width: '100%',
        height: '100%-7',
        border: 'line',
        label: ' Copilot Output ',
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        keys: false,
        mouse: true,
        vi: true,
        content:
          'Use Enter for free-form prompt, h for fleet health summary, s for command suggestions. Outputs are advisory only.'
      });
      context.debugLog?.('nav.list.nativeKeysDisabled', {
        screen: 'copilot',
        widgets: ['provider-box', 'output-box']
      });
    },
    unmount() {
      isMounted = false;
      root?.destroy();
      root = undefined;
    },
    async refresh() {
      await renderScene();
    },
    focus() {
      focusPane();
    },
    getActivePane() {
      return activePane;
    },
    getAvailablePanes() {
      return paneConfig.panes;
    },
    async handleArrow(key: TuiArrowKey) {
      if (key === 'left' || key === 'right') {
        const next = movePaneWithBoundary(paneConfig.panes, activePane, key);
        if (next.boundary) {
          return 'boundary';
        }
        activePane = next.pane;
        focusPane();
        context.setStatus(`Pane: ${activePane}`);
        return 'handled';
      }

      const delta = key === 'up' ? -1 : key === 'down' ? 1 : 0;
      if (!delta) {
        return 'unhandled';
      }

      if (activePane === 'output-box') {
        scrollBox(output, delta);
        context.screen.render();
        return 'handled';
      }

      if (activePane === 'provider-box') {
        scrollBox(providerBox, delta);
        context.screen.render();
        return 'handled';
      }

      return 'unhandled';
    },
    async handleKey(ch, key) {
      if (key.name === 'enter') {
        const promptText = input?.getValue()?.trim() ?? '';
        if (!promptText) {
          context.setStatus('Copilot prompt is empty.');
          return true;
        }

        context.setStatus('Running copilot prompt...');
        try {
          const override = context.getProviderOverride();
          const tenantId = await context.getActiveTenantId();
          const result = await context.llm.run({
            tenantId,
            provider: override.provider,
            model: override.model,
            system: 'You are a Xyte operations copilot. Keep answers concise and action-oriented.',
            user: promptText
          });

          await appendOutput(`Prompt: ${promptText}\nAnswer: ${result.text}`);
          context.setStatus('Copilot response complete.');
        } catch (error) {
          context.showError(error);
        }

        return true;
      }

      if (ch === 'h') {
        context.setStatus('Generating fleet health summary...');
        try {
          const tenantId = await context.getActiveTenantId();
          const [devices, incidents, tickets] = await Promise.all([
            context.client.organization.getDevices({ tenantId }).catch(() => []),
            context.client.organization.getIncidents({ tenantId }).catch(() => []),
            context.client.organization.getTickets({ tenantId }).catch(() => [])
          ]);

          const summary = await context.runHealthSummary({ devices, incidents, tickets });
          await appendOutput(
            [
              'Fleet Health Summary',
              summary.overview,
              `Trend: ${summary.onlineOfflineTrend}`,
              `Top spaces: ${summary.topProblematicSpaces.join(', ') || 'n/a'}`,
              `Top models: ${summary.topProblematicModels.join(', ') || 'n/a'}`,
              `Anomalies: ${summary.anomalies.join('; ') || 'none'}`
            ].join('\n')
          );
          context.setStatus('Fleet health summary complete.');
        } catch (error) {
          context.showError(error);
        }

        return true;
      }

      if (ch === 's') {
        context.setStatus('Generating command suggestions...');
        try {
          const tenantId = await context.getActiveTenantId();
          const devicesRaw = await context.client.organization
            .getDevices({ tenantId })
            .catch(() => context.client.partner.getDevices({ tenantId }))
            .catch(() => []);
          const incidents = await context.client.organization.getIncidents({ tenantId }).catch(() => []);

          const devices = Array.isArray(devicesRaw)
            ? devicesRaw
            : ((devicesRaw as any)?.data ?? (devicesRaw as any)?.items ?? (devicesRaw as any)?.devices ?? []);
          const device = devices[0];
          if (!device) {
            await appendOutput('No device available for command suggestion.');
            return true;
          }

          const suggestions = await context.runCommandSuggestions({
            device,
            recentIncidents: incidents,
            goal: 'stabilize device and verify current operating state'
          });

          await appendOutput(
            [
              'Command Suggestions',
              ...suggestions.recommendations.map(
                (item, index) => `${index + 1}. ${item.command} [${item.risk}] - ${item.rationale}`
              ),
              '',
              `Safety note: ${suggestions.safetyNote}`
            ].join('\n')
          );
          context.setStatus('Command suggestions ready (advisory only).');
        } catch (error) {
          context.showError(error);
        }
        return true;
      }

      return false;
    }
  };
}
