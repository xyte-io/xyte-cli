import blessed from 'blessed';

import {
  clampIndex,
  handleHorizontalArrow,
  moveTableSelection,
  setListTableData,
  scrollBox,
  shouldIgnoreSelectEvent,
  syncListSelection,
  type SelectionSyncState
} from '../navigation';
import { SCREEN_PANE_CONFIG } from '../panes';
import { createRenderErrorTracker } from '../render-error-tracker';
import { createScreenRenderLogger, logScreenDataFetch } from '../screen-render-logger';
import type { TuiArrowKey, TuiContext, NavigableScreen, TuiPaneId } from '../types';
import type { CommandTemplate } from '../data-loaders';
import { loadCommandTemplates, loadDevicesData } from '../data-loaders';
import { sceneFromDevicesState } from '../scene';
import { payloadSummary, safeSearchText } from '../serialize';
import {
  confirmWriteWithToken,
  openActionPalette,
  parseJsonObjectInput,
  promptChoice,
  runGuardedAction
} from '../actions';
import { errorMessage } from '../../utils/error-format';
import { asRecord, asRecordOrUndefined } from '../../utils/json';
import { prepareModelBackedDeviceCommandBody } from '../../workflows/device-command';

function deviceIdOf(device: unknown): string {
  const rec = asRecordOrUndefined(device);
  return String(rec?.id ?? rec?._id ?? rec?.device_id ?? '');
}

function renderDeviceFallbackTable(
  table: blessed.Widgets.ListTableElement | undefined,
  filtered: unknown[],
  selectionSync: SelectionSyncState
): void {
  if (!table) return;
  setListTableData(
    table,
    [
      ['ID', 'Name', 'Status', 'Space'],
      ...filtered.map((device, index) => {
        const d = asRecord(device);
        return [
          String(d.id ?? d._id ?? `row-${index + 1}`),
          String(d.name ?? d.title ?? 'n/a'),
          String(d.status ?? d.state ?? 'unknown'),
          String(d.space_name ?? d.space_id ?? 'n/a')
        ];
      })
    ],
    selectionSync
  );
}

interface SendCommandWithGuardArgs {
  device: unknown;
  template: CommandTemplate;
  params: Record<string, unknown> | undefined;
  fileId?: string;
  context: Pick<TuiContext, 'confirmWrite' | 'setStatus' | 'showError' | 'getActiveTenantId' | 'client'>;
}

export async function sendCommandWithGuard(args: SendCommandWithGuardArgs): Promise<boolean> {
  const deviceId = deviceIdOf(args.device);
  if (!deviceId) {
    args.context.setStatus('Selected device has no id.');
    return false;
  }

  const body: Record<string, unknown> =
    args.template.mode === 'command' ? { command: args.template.value } : { friendly_name: args.template.value };
  if (args.params && Object.keys(args.params).length > 0) {
    body.extra_params = args.params;
  }
  if (args.fileId?.trim()) {
    body.file_id = args.fileId.trim();
  }
  let validatedBody: Record<string, unknown>;
  try {
    validatedBody = prepareModelBackedDeviceCommandBody({
      evidence: args.template.modelEvidence,
      bodyPayload: body,
      sourceLabel: 'Command send'
    });
  } catch (error) {
    args.context.showError(error);
    return false;
  }

  const ok = await confirmWriteWithToken({
    context: args.context,
    actionLabel: 'Send command',
    token: 'command',
    cancelStatus: 'Send command canceled.'
  });
  if (!ok) {
    return false;
  }

  return runGuardedAction(args.context, 'Sending command...', async (tenantId) => {
    await args.context.client.organization.sendCommand({
      tenantId,
      path: { device_id: deviceId },
      body: validatedBody
    });
    args.context.setStatus(`Command sent to device ${deviceId}.`);
  });
}

async function runSendCommandWizard(args: {
  context: TuiContext;
  getIsMounted: () => boolean;
  selectedDevice: () => unknown;
  refreshDevices: (deviceId?: string) => Promise<void>;
}): Promise<void> {
  const { context, getIsMounted, selectedDevice, refreshDevices } = args;
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
  const templatesOutcome = await loadCommandTemplates(context.client, tenantId, { deviceId });
  if (templatesOutcome.error) {
    context.setStatus(`Command templates unavailable: ${templatesOutcome.error.message}`);
    return;
  }
  if (!templatesOutcome.data.length) {
    context.setStatus('No command templates available for selected device.');
    return;
  }

  const choice = await promptChoice({
    context,
    title: `Command templates for ${deviceId}`,
    choices: templatesOutcome.data.map((template: CommandTemplate) => ({
      label: template.label,
      value: `${template.mode}:${template.value}`
    }))
  });
  if (!choice || !getIsMounted()) {
    return;
  }
  const selectedTemplate = templatesOutcome.data.find(
    (template: CommandTemplate) => `${template.mode}:${template.value}` === choice.value
  );
  if (!selectedTemplate) {
    context.setStatus('Template selection is invalid.');
    return;
  }

  const paramsInput = await context.prompt('Command params JSON object (empty only when model permits):', '');
  if (paramsInput === undefined || !getIsMounted()) {
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

  let fileId: string | undefined;
  if (selectedTemplate.withFile) {
    const fileInput = await context.prompt('File ID required by this command:', '');
    if (fileInput === undefined || !getIsMounted()) {
      context.setStatus('Send command canceled.');
      return;
    }
    fileId = fileInput.trim();
    if (!fileId) {
      context.setStatus('File ID is required for this command.');
      return;
    }
  }

  const sent = await sendCommandWithGuard({ device, template: selectedTemplate, params, fileId, context });
  if (sent && getIsMounted()) {
    await refreshDevices(deviceId);
  }
}

export function createDevicesScreen(): NavigableScreen {
  let root: blessed.Widgets.BoxElement | undefined;
  let table: blessed.Widgets.ListTableElement | undefined;
  let detail: blessed.Widgets.BoxElement | undefined;
  let context: TuiContext;
  let devices: unknown[] = [];
  let filtered: unknown[] = [];
  let searchText = '';
  let selectedIndex = 0;
  let selectionSync: SelectionSyncState = {
    syncing: false,
    name: 'devices-table'
  };
  const paneConfig = SCREEN_PANE_CONFIG.devices;
  let activePane: TuiPaneId = paneConfig.defaultPane;
  let isMounted = false;
  const renderErrors = createRenderErrorTracker();
  const renderLog = createScreenRenderLogger('devices', () => context.debugLog, renderErrors);
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
    renderLog.onRenderStart();
    if (!searchText) {
      filtered = devices;
    } else {
      const needle = searchText.toLowerCase();
      filtered = devices.filter((device) => safeSearchText(device).includes(needle));
    }
    const restoreIndex = restoreDeviceId ? filtered.findIndex((device) => deviceIdOf(device) === restoreDeviceId) : -1;
    selectedIndex = restoreIndex >= 0 ? restoreIndex : clampIndex(selectedIndex, filtered.length);

    const actionsHint = 'actions: a send-command, f endpoint filter';

    try {
      if (renderErrors.frozen) {
        renderDeviceFallbackTable(table, filtered, selectionSync);
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

        setListTableData(
          table,
          [
            (tablePanel?.table?.columns ?? ['ID', 'Name', 'Status', 'Space']) as [string, string, string, string],
            ...((tablePanel?.table?.rows ?? []) as Array<[string, string, string, string]>)
          ],
          selectionSync
        );
        detail?.setContent((detailPanel?.text?.lines ?? ['No matching devices.']).join('\n'));
      }
      renderErrors.recordSuccess();
      renderLog.onRenderComplete();
    } catch (error) {
      const message = errorMessage(error);
      renderErrors.recordError(message);
      renderLog.onRenderError(message);

      renderDeviceFallbackTable(table, filtered, selectionSync);
      detail?.setContent(
        [
          'Unable to render device detail safely.',
          `Reason: ${message}`,
          'Try narrowing search/filter and refresh.'
        ].join('\n')
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
    logScreenDataFetch(context.debugLog, 'devices', 'start', { tenantId, spaceFilter });
    const loaded = await loadDevicesData(context.client, tenantId, {
      profileStore: context.profileStore,
      query: {
        space_id: spaceFilter || undefined
      }
    });
    if (!isMounted) {
      return;
    }
    devices = loaded.data;
    logScreenDataFetch(context.debugLog, 'devices', 'complete', {
      tenantId,
      count: devices.length,
      connectionState: loaded.connectionState,
      retry: loaded.retry,
      payload: payloadSummary(devices),
      spaceFilter
    });
    if (loaded.error) {
      context.setStatus(`Devices ${loaded.connectionState}: ${loaded.error.message}`);
      logScreenDataFetch(context.debugLog, 'devices', 'error', {
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
    async handleArrow(key: TuiArrowKey) {
      const h = handleHorizontalArrow(key, paneConfig.panes, activePane, (newPane) => {
        activePane = newPane;
        focusPane();
        context.setStatus(`Pane: ${activePane}`);
      });
      if (h !== null) return h;

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
        await openActionPalette({
          context,
          title: 'Device actions',
          actions: [
            {
              label: 'Send command',
              run: () =>
                runSendCommandWizard({
                  context,
                  getIsMounted: () => isMounted,
                  selectedDevice,
                  refreshDevices
                })
            }
          ]
        });
        return true;
      }

      if (key.name === 'enter') {
        applyFilter();
        return true;
      }

      return false;
    }
  };
}
