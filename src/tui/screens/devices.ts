import blessed, { type Widgets } from 'blessed';

import {
  clampIndex,
  movePaneWithBoundary,
  moveTableSelection,
  setListTableData,
  scrollBox,
  shouldIgnoreSelectEvent,
  syncListSelection,
  type SelectionSyncState
} from '../navigation';
import { SCREEN_PANE_CONFIG } from '../panes';
import type { TuiArrowKey, TuiContext, TuiPaneId, TuiScreen } from '../types';
import type { CommandTemplate } from '../data-loaders';
import { loadCommandTemplates, loadDevicesData } from '../data-loaders';
import { sceneFromDevicesState } from '../scene';
import { payloadSummary, safeInspect, safeSearchText } from '../serialize';
import { confirmWriteWithToken, openActionPalette, parseJsonObjectInput, promptChoice } from '../actions';

function deviceIdOf(device: any): string {
  return String(device?.id ?? device?._id ?? device?.device_id ?? '');
}

interface SendCommandWithGuardArgs {
  device: any;
  template: CommandTemplate;
  params: Record<string, unknown> | undefined;
  context: Pick<TuiContext, 'confirmWrite' | 'setStatus' | 'showError' | 'getActiveTenantId' | 'client'>;
}

export async function sendCommandWithGuard(args: SendCommandWithGuardArgs): Promise<boolean> {
  const deviceId = deviceIdOf(args.device);
  if (!deviceId) {
    args.context.setStatus('Selected device has no id.');
    return false;
  }

  const ok = await confirmWriteWithToken(args.context, 'Send command', 'command', 'Send command canceled.');
  if (!ok) {
    return false;
  }

  const body: Record<string, unknown> = args.template.mode === 'command'
    ? { command: args.template.value }
    : { friendly_name: args.template.value };
  if (args.params && Object.keys(args.params).length > 0) {
    body.params = args.params;
  }

  args.context.setStatus('Sending command...');
  try {
    const tenantId = await args.context.getActiveTenantId();
    await args.context.client.organization.sendCommand({
      tenantId,
      path: { device_id: deviceId },
      body
    });
    args.context.setStatus(`Command sent to device ${deviceId}.`);
    return true;
  } catch (error) {
    args.context.showError(error);
    return false;
  }
}

export function createDevicesScreen(): TuiScreen {
  let root: Widgets.BoxElement | undefined;
  let table: Widgets.ListTableElement | undefined;
  let detail: Widgets.BoxElement | undefined;
  let context: TuiContext;
  let devices: any[] = [];
  let filtered: any[] = [];
  let searchText = '';
  let selectedIndex = 0;
  let selectionSync: SelectionSyncState = {
    syncing: false,
    name: 'devices-table'
  };
  const paneConfig = SCREEN_PANE_CONFIG.devices;
  let activePane: TuiPaneId = paneConfig.defaultPane;
  let isMounted = false;
  let renderErrorMessage = '';
  let renderErrorCount = 0;
  let renderErrorWindowStart = 0;
  let renderFrozen = false;
  let spaceFilter = '';

  const focusPane = () => {
    if (activePane === 'devices-table') {
      table?.focus();
      return;
    }
    detail?.focus();
  };

  const selectedDevice = () => filtered[selectedIndex];

  const applyFilter = (restoreDeviceId?: string) => {
    if (!isMounted) {
      return;
    }
    context.debugLog?.('screen.render.start', {
      screen: 'devices'
    });
    if (!searchText) {
      filtered = devices;
    } else {
      const needle = searchText.toLowerCase();
      filtered = devices.filter((device) => safeSearchText(device).includes(needle));
    }
    if (restoreDeviceId) {
      const restoreIndex = filtered.findIndex((device) => deviceIdOf(device) === restoreDeviceId);
      selectedIndex = restoreIndex >= 0 ? restoreIndex : clampIndex(selectedIndex, filtered.length);
    } else {
      selectedIndex = clampIndex(selectedIndex, filtered.length);
    }

    const actionsHint = 'actions: a send-command, f endpoint filter';

    try {
      if (renderFrozen) {
        setListTableData(table, [
          ['ID', 'Name', 'Status', 'Space'],
          ...filtered.map((device, index) => [
            String(device?.id ?? device?._id ?? `row-${index + 1}`),
            String(device?.name ?? device?.title ?? 'n/a'),
            String(device?.status ?? device?.state ?? 'unknown'),
            String(device?.space_name ?? device?.space_id ?? 'n/a')
          ])
        ], selectionSync);
        detail?.setContent(
          [
            'Render fallback mode enabled.',
            'Previous render errors were repeated. Refresh (r) after reducing payload complexity.'
          ].join('\n')
        );
      } else {
        const panels = sceneFromDevicesState({
          searchText,
          selectedIndex,
          devices: filtered,
          spaceFilter,
          actionsHint
        });

        const tablePanel = panels.find((panel) => panel.id === 'devices-table');
        const detailPanel = panels.find((panel) => panel.id === 'devices-detail');

        setListTableData(table, [
          (tablePanel?.table?.columns ?? ['ID', 'Name', 'Status', 'Space']) as [string, string, string, string],
          ...((tablePanel?.table?.rows ?? []) as Array<[string, string, string, string]>)
        ], selectionSync);
        detail?.setContent((detailPanel?.text?.lines ?? ['No matching devices.']).join('\n'));
      }
      renderErrorMessage = '';
      renderErrorCount = 0;
      renderErrorWindowStart = 0;
      context.debugLog?.('screen.render.complete', {
        screen: 'devices',
        frozen: renderFrozen
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const now = Date.now();
      if (message === renderErrorMessage && now - renderErrorWindowStart <= 2_000) {
        renderErrorCount += 1;
      } else {
        renderErrorMessage = message;
        renderErrorCount = 1;
        renderErrorWindowStart = now;
      }
      if (renderErrorCount >= 3) {
        renderFrozen = true;
      }

      context.debugLog?.('screen.render.error', {
        screen: 'devices',
        message,
        count: renderErrorCount,
        frozen: renderFrozen
      });
      context.debugLog?.('screen.render.fallback.applied', {
        screen: 'devices'
      });

      setListTableData(table, [
        ['ID', 'Name', 'Status', 'Space'],
        ...filtered.map((device, index) => [
          String(device?.id ?? device?._id ?? `row-${index + 1}`),
          String(device?.name ?? device?.title ?? 'n/a'),
          String(device?.status ?? device?.state ?? 'unknown'),
          String(device?.space_name ?? device?.space_id ?? 'n/a')
        ])
      ], selectionSync);
      detail?.setContent(
        ['Unable to render device detail safely.', `Reason: ${message}`, 'Try narrowing search/filter and refresh.'].join('\n')
      );
    }
    syncListSelection(table, selectedIndex, selectionSync);
    focusPane();
    context.screen.render();
  };

  const refreshDevices = async (restoreDeviceId?: string) => {
    if (!context || !isMounted) {
      return;
    }

    const tenantId = await context.getActiveTenantId();
    context.debugLog?.('screen.data.fetch.start', {
      screen: 'devices',
      tenantId,
      spaceFilter
    });
    const loaded = await loadDevicesData(context.client, tenantId, {
      query: {
        space_id: spaceFilter || undefined
      }
    });
    if (!isMounted) {
      return;
    }
    devices = loaded.data;
    context.debugLog?.('screen.data.fetch.complete', {
      screen: 'devices',
      tenantId,
      count: devices.length,
      connectionState: loaded.connectionState,
      retry: loaded.retry,
      payload: payloadSummary(devices),
      spaceFilter
    });
    if (loaded.error) {
      context.setStatus(`Devices ${loaded.connectionState}: ${loaded.error.message}`);
      context.debugLog?.('screen.data.fetch.error', {
        screen: 'devices',
        message: loaded.error.message,
        state: loaded.connectionState
      });
    }
    applyFilter(restoreDeviceId);
  };

  return {
    id: 'devices',
    title: 'Devices',
    mount(parent, ctx) {
      context = ctx;
      selectionSync = {
        syncing: false,
        name: 'devices-table',
        onLog: (event, data) => context.debugLog?.(event, data)
      };
      isMounted = true;
      root = blessed.box({
        parent,
        width: '100%-2',
        height: '100%-2',
        top: 0,
        left: 0
      });

      table = blessed.listtable({
        parent: root,
        top: 0,
        left: 0,
        width: '100%',
        height: '60%',
        border: 'line',
        label: ' Devices ',
        keys: false,
        mouse: true,
        data: [['ID', 'Name', 'Status', 'Space']],
        style: {
          header: { bold: true, fg: 'black', bg: 'white' },
          cell: { selected: { bg: 'blue' } }
        }
      });

      detail = blessed.box({
        parent: root,
        top: '60%',
        left: 0,
        width: '100%',
        height: '40%',
        border: 'line',
        label: ' Details ',
        scrollable: true,
        alwaysScroll: true,
        keys: false,
        mouse: true,
        vi: true,
        content: 'Select a device to view details.'
      });
      context.debugLog?.('nav.list.nativeKeysDisabled', {
        screen: 'devices',
        widgets: ['devices-table', 'detail-box']
      });

      table.on('select item', (_item: unknown, index: number) => {
        if (shouldIgnoreSelectEvent(selectionSync)) {
          return;
        }
        selectedIndex = Math.max(0, index - 1);
        applyFilter();
      });
    },
    unmount() {
      isMounted = false;
      root?.destroy();
      root = undefined;
    },
    async refresh() {
      await refreshDevices(deviceIdOf(selectedDevice()));
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
    getCtaHints() {
      return [
        'a send command',
        'f space filter',
        '/ search devices',
        'o deep details'
      ];
    },
    getEntityDetails() {
      const device = selectedDevice();
      if (!device) {
        return undefined;
      }
      const inspected = safeInspect(device, {
        maxDepth: 6,
        maxArrayItems: 60,
        maxObjectKeys: 120,
        maxOutputChars: 8_000
      });
      return {
        title: `Device ${deviceIdOf(device) || '(unknown)'}`,
        content: inspected.text,
        hint: 'Use a to execute commands for this device.'
      };
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

      if (activePane === 'devices-table') {
        const beforeIndex = selectedIndex;
        selectedIndex = moveTableSelection({
          table,
          index: selectedIndex,
          delta,
          totalRows: filtered.length,
          selectionSync
        });
        context.debugLog?.('nav.arrow.updown', {
          screen: 'devices',
          pane: activePane,
          beforeIndex,
          afterIndex: selectedIndex,
          delta
        });
        applyFilter();
        return 'handled';
      }

      scrollBox(detail, delta);
      context.screen.render();
      return 'handled';
    },
    async handleKey(ch, key) {
      if (key.name === 'slash' || ch === '/') {
        const value = await context.prompt('Search devices (empty clears):', searchText);
        if (!isMounted) {
          return true;
        }
        if (value !== undefined) {
          searchText = value.trim();
          selectedIndex = 0;
          applyFilter();
        }
        return true;
      }

      if (ch === 'f') {
        const value = await context.prompt('Space ID filter (empty clears):', spaceFilter);
        if (value === undefined || !isMounted) {
          return true;
        }
        spaceFilter = value.trim();
        selectedIndex = 0;
        await refreshDevices();
        return true;
      }

      if (ch === 'a') {
        return openActionPalette({
          context,
          title: 'Device actions',
          actions: [
            {
              label: 'Send command',
              run: async () => {
                const device = selectedDevice();
                if (!device) {
                  context.setStatus('No device selected.');
                  return;
                }
                const deviceId = deviceIdOf(device);
                if (!deviceId) {
                  context.setStatus('Selected device has no id.');
                  return;
                }
                const tenantId = await context.getActiveTenantId();
                const templatesOutcome = await loadCommandTemplates(context.client, tenantId, deviceId);
                if (templatesOutcome.error) {
                  context.setStatus(`Command templates unavailable: ${templatesOutcome.error.message}`);
                  return;
                }
                if (!templatesOutcome.data.length) {
                  context.setStatus('No command templates available for selected device.');
                  return;
                }

                const choice = await promptChoice(context, {
                  title: `Command templates for ${deviceId}`,
                  choices: templatesOutcome.data.map((template) => ({
                    label: template.label,
                    value: `${template.mode}:${template.value}`
                  }))
                });
                if (!choice || !isMounted) {
                  return;
                }
                const selectedTemplate = templatesOutcome.data.find(
                  (template) => `${template.mode}:${template.value}` === choice.value
                );
                if (!selectedTemplate) {
                  context.setStatus('Template selection is invalid.');
                  return;
                }

                const paramsInput = await context.prompt('Optional params JSON object (empty skips):', '');
                if (paramsInput === undefined || !isMounted) {
                  context.setStatus('Send command canceled.');
                  return;
                }
                let params: Record<string, unknown> | undefined;
                if (paramsInput.trim()) {
                  const parsed = parseJsonObjectInput(paramsInput);
                  if (!parsed.ok) {
                    context.setStatus(`Invalid params JSON: ${parsed.error}`);
                    return;
                  }
                  params = parsed.value;
                }

                const sent = await sendCommandWithGuard({
                  device,
                  template: selectedTemplate,
                  params,
                  context
                });
                if (sent && isMounted) {
                  await refreshDevices(deviceId);
                }
              }
            }
          ]
        });
      }

      if (key.name === 'enter') {
        applyFilter();
        return true;
      }

      return false;
    }
  };
}
