import blessed from 'blessed';

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
import { loadDevicesData } from '../data-loaders';
import { sceneFromDevicesState } from '../scene';
import { payloadSummary, safeSearchText } from '../serialize';

export function createDevicesScreen(): TuiScreen {
  let root: blessed.Widgets.BoxElement | undefined;
  let table: blessed.Widgets.ListTableElement | undefined;
  let detail: blessed.Widgets.BoxElement | undefined;
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

  const focusPane = () => {
    if (activePane === 'devices-table') {
      table?.focus();
      return;
    }
    detail?.focus();
  };

  const applyFilter = () => {
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
    selectedIndex = clampIndex(selectedIndex, filtered.length);

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
          devices: filtered
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

      table.on('select item', (_item, index) => {
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
      if (!context || !isMounted) {
        return;
      }

      const tenantId = await context.getActiveTenantId();
      context.debugLog?.('screen.data.fetch.start', {
        screen: 'devices',
        tenantId
      });
      const loaded = await loadDevicesData(context.client, tenantId);
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
        payload: payloadSummary(devices)
      });
      if (loaded.error) {
        context.setStatus(`Devices ${loaded.connectionState}: ${loaded.error.message}`);
        context.debugLog?.('screen.data.fetch.error', {
          screen: 'devices',
          message: loaded.error.message,
          state: loaded.connectionState
        });
      }
      applyFilter();
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

      if (key.name === 'enter') {
        applyFilter();
        return true;
      }

      return false;
    }
  };
}
