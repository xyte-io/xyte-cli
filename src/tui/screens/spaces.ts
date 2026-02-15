import blessed from 'blessed';

import {
  clampIndex,
  movePaneWithBoundary,
  moveTableSelection,
  scrollBox,
  setListTableData,
  shouldIgnoreSelectEvent,
  syncListSelection,
  type SelectionSyncState
} from '../navigation';
import { SCREEN_PANE_CONFIG } from '../panes';
import type { TuiArrowKey, TuiContext, TuiScreen } from '../types';
import {
  getSpaceId,
  getSpaceName,
  loadDevicesData,
  loadSpaceDrilldownData,
  loadSpacesData
} from '../data-loaders';
import { sceneFromSpacesState } from '../scene';
import { safeSearchText } from '../serialize';

const SPINNER_FRAMES = ['|', '/', '-', '\\'];

export function createStaleSafeSelectionLoader<TInput, TResult>(args: {
  load: (input: TInput) => Promise<TResult>;
  apply: (result: TResult) => void;
}): (input: TInput) => Promise<boolean> {
  let token = 0;

  return async (input: TInput): Promise<boolean> => {
    const current = ++token;
    const result = await args.load(input);
    if (current !== token) {
      return false;
    }
    args.apply(result);
    return true;
  };
}

export function createSpacesScreen(): TuiScreen {
  let root: blessed.Widgets.BoxElement | undefined;
  let spaceTable: blessed.Widgets.ListTableElement | undefined;
  let detailBox: blessed.Widgets.BoxElement | undefined;
  let devicesTable: blessed.Widgets.ListTableElement | undefined;
  let statusBox: blessed.Widgets.BoxElement | undefined;
  let context: TuiContext;

  let spaces: any[] = [];
  let filtered: any[] = [];
  let searchText = '';
  let selectedIndex = 0;
  let selectedSpaceId: string | undefined;
  let selectedSpaceDetail: unknown;
  let devicesInSpace: any[] = [];
  let selectedDeviceIndex = 0;
  let paneStatus = 'No space selected.';
  let loading = false;
  let spinnerPhase = 0;
  let spinnerTimer: NodeJS.Timeout | undefined;
  let selectionDebounceTimer: NodeJS.Timeout | undefined;
  let allDevicesCache: any[] = [];
  let activeTenantId: string | undefined;
  let spaceSelectionSync: SelectionSyncState = {
    syncing: false,
    name: 'spaces-table'
  };
  const paneConfig = SCREEN_PANE_CONFIG.spaces;
  let activePane = paneConfig.defaultPane;
  let isMounted = false;

  const focusPane = () => {
    if (activePane === 'spaces-table') {
      spaceTable?.focus();
      return;
    }
    if (activePane === 'detail-box') {
      detailBox?.focus();
      return;
    }
    devicesTable?.focus();
  };

  const stopSpinner = () => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
  };

  const clearSelectionDebounce = () => {
    if (selectionDebounceTimer) {
      clearTimeout(selectionDebounceTimer);
      selectionDebounceTimer = undefined;
    }
  };

  const startSpinner = () => {
    stopSpinner();
    spinnerTimer = setInterval(() => {
      if (!statusBox || !loading) {
        return;
      }
      spinnerPhase += 1;
      const spinner = SPINNER_FRAMES[spinnerPhase % SPINNER_FRAMES.length];
      statusBox.setContent(` ${spinner} ${paneStatus}`);
      context.screen.render();
    }, 140);
  };

  const renderState = () => {
    if (!isMounted) {
      return;
    }
    if (!spaceTable || !detailBox || !devicesTable || !statusBox) {
      return;
    }

    const panels = sceneFromSpacesState({
      tenantId: activeTenantId,
      searchText,
      selectedIndex,
      loading,
      paneStatus,
      spaces: filtered,
      spaceDetail: selectedSpaceDetail,
      devicesInSpace
    });

    const listPanel = panels.find((panel) => panel.id === 'spaces-list');
    const detailPanel = panels.find((panel) => panel.id === 'spaces-detail');
    const devicesPanel = panels.find((panel) => panel.id === 'spaces-devices');

    setListTableData(spaceTable, [
      (listPanel?.table?.columns ?? ['ID', 'Name', 'Type', 'Path']) as [string, string, string, string],
      ...((listPanel?.table?.rows ?? []) as Array<[string, string, string, string]>)
    ], spaceSelectionSync);
    syncListSelection(spaceTable, selectedIndex, spaceSelectionSync);

    detailBox.setContent((detailPanel?.text?.lines ?? ['No space selected.']).join('\n'));

    setListTableData(devicesTable, [
      (devicesPanel?.table?.columns ?? ['ID', 'Name', 'Status']) as [string, string, string],
      ...((devicesPanel?.table?.rows ?? []) as Array<[string, string, string]>)
    ]);
    devicesTable.select(clampIndex(selectedDeviceIndex, devicesInSpace.length) + 1);

    const statusPrefix = loading ? `${SPINNER_FRAMES[spinnerPhase % SPINNER_FRAMES.length]} ` : '';
    statusBox.setContent(` ${statusPrefix}${paneStatus}`);
    focusPane();
    context.screen.render();
  };

  const staleSafeDrilldown = createStaleSafeSelectionLoader<{ index: number; tenantId?: string }, {
    selectedSpaceId: string;
    selectedSpaceDetail: unknown;
    devicesInSpace: any[];
    paneStatus: string;
    index: number;
  }>({
    async load(input) {
      const selected = filtered[input.index];
      if (!selected) {
        return {
          selectedSpaceId: '',
          selectedSpaceDetail: undefined,
          devicesInSpace: [],
          paneStatus: 'No space selected.',
          index: input.index
        };
      }

      const id = getSpaceId(selected);
      const drilldown = await loadSpaceDrilldownData(context.client, input.tenantId, id, allDevicesCache);
      return {
        selectedSpaceId: id,
        selectedSpaceDetail: drilldown.data.spaceDetail,
        devicesInSpace: drilldown.data.devicesInSpace,
        paneStatus: `${drilldown.data.paneStatus}${drilldown.error ? ` | ${drilldown.error.message}` : ''} (${getSpaceName(selected)})`,
        index: input.index
      };
    },
    apply(result) {
      if (!isMounted) {
        return;
      }
      loading = false;
      stopSpinner();
      selectedIndex = result.index;
      selectedSpaceId = result.selectedSpaceId;
      selectedSpaceDetail = result.selectedSpaceDetail;
      devicesInSpace = result.devicesInSpace;
      selectedDeviceIndex = 0;
      paneStatus = result.paneStatus;
      renderState();
    }
  });

  const loadSelection = async (index: number) => {
    if (!isMounted) {
      return;
    }
    const tenantId = await context.getActiveTenantId();
    selectedIndex = Math.max(0, Math.min(index, Math.max(filtered.length - 1, 0)));
    loading = true;
    paneStatus = 'Loading selected space...';
    startSpinner();
    renderState();

    const applied = await staleSafeDrilldown({ index: selectedIndex, tenantId });
    if (!applied) {
      return;
    }
  };

  const scheduleSelectionLoad = (index: number) => {
    clearSelectionDebounce();
    selectionDebounceTimer = setTimeout(() => {
      selectionDebounceTimer = undefined;
      void loadSelection(index);
    }, 120);
  };

  const applyFilter = () => {
    if (!searchText) {
      filtered = spaces;
    } else {
      const needle = searchText.toLowerCase();
      filtered = spaces.filter((space) => safeSearchText(space).includes(needle));
    }

    if (!filtered.length) {
      selectedIndex = 0;
      selectedSpaceId = undefined;
      selectedSpaceDetail = undefined;
      devicesInSpace = [];
      selectedDeviceIndex = 0;
      paneStatus = 'No spaces matched the current filter.';
      loading = false;
      stopSpinner();
      renderState();
      return;
    }

    if (selectedSpaceId) {
      const matchIndex = filtered.findIndex((space) => getSpaceId(space) === selectedSpaceId);
      if (matchIndex >= 0) {
        selectedIndex = matchIndex;
      } else {
        selectedIndex = 0;
      }
    } else {
      selectedIndex = 0;
    }

    renderState();
  };

  return {
    id: 'spaces',
    title: 'Spaces',
    mount(parent, ctx) {
      context = ctx;
      spaceSelectionSync = {
        syncing: false,
        name: 'spaces-table',
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

      spaceTable = blessed.listtable({
        parent: root,
        top: 0,
        left: 0,
        width: '35%',
        height: '100%-1',
        border: 'line',
        label: ' Spaces ',
        keys: false,
        mouse: true,
        data: [['ID', 'Name', 'Type', 'Path']],
        style: {
          header: { bold: true, fg: 'black', bg: 'white' },
          cell: { selected: { bg: 'blue' } }
        }
      });

      detailBox = blessed.box({
        parent: root,
        top: 0,
        left: '35%',
        width: '30%',
        height: '100%-1',
        border: 'line',
        label: ' Space Detail ',
        scrollable: true,
        alwaysScroll: true,
        keys: false,
        mouse: true,
        vi: true,
        content: 'Select a space to load details.'
      });

      devicesTable = blessed.listtable({
        parent: root,
        top: 0,
        left: '65%',
        width: '35%',
        height: '100%-1',
        border: 'line',
        label: ' Devices In Space ',
        keys: false,
        mouse: true,
        data: [['ID', 'Name', 'Status']],
        style: {
          header: { bold: true, fg: 'black', bg: 'white' },
          cell: { selected: { bg: 'blue' } }
        }
      });
      context.debugLog?.('nav.list.nativeKeysDisabled', {
        screen: 'spaces',
        widgets: ['spaces-table', 'detail-box', 'devices-table']
      });

      statusBox = blessed.box({
        parent: root,
        bottom: 0,
        left: 0,
        width: '100%',
        height: 1,
        content: ' Ready ',
        style: {
          fg: 'black',
          bg: 'green'
        }
      });

      spaceTable.on('select item', (_item, index) => {
        if (shouldIgnoreSelectEvent(spaceSelectionSync)) {
          return;
        }
        clearSelectionDebounce();
        void loadSelection(Math.max(0, index - 1));
      });
    },
    unmount() {
      isMounted = false;
      stopSpinner();
      clearSelectionDebounce();
      root?.destroy();
      root = undefined;
    },
    async refresh() {
      if (!context || !isMounted) {
        return;
      }

      const tenantId = await context.getActiveTenantId();
      if (!isMounted) {
        return;
      }
      activeTenantId = tenantId;
      const [nextSpacesOutcome, devicesCacheOutcome] = await Promise.all([
        loadSpacesData(context.client, tenantId),
        loadDevicesData(context.client, tenantId)
      ]);

      spaces = nextSpacesOutcome.data;
      allDevicesCache = devicesCacheOutcome.data;
      if (!isMounted) {
        return;
      }
      applyFilter();

      if (nextSpacesOutcome.error) {
        context.setStatus(`Spaces ${nextSpacesOutcome.connectionState}: ${nextSpacesOutcome.error.message}`);
      }

      if (filtered.length) {
        clearSelectionDebounce();
        await loadSelection(selectedIndex);
      }
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

      if (activePane === 'spaces-table') {
        const beforeIndex = selectedIndex;
        selectedIndex = moveTableSelection({
          table: spaceTable,
          index: selectedIndex,
          delta,
          totalRows: filtered.length,
          selectionSync: spaceSelectionSync
        });
        context.debugLog?.('nav.arrow.updown', {
          screen: 'spaces',
          pane: activePane,
          beforeIndex,
          afterIndex: selectedIndex,
          delta
        });
        scheduleSelectionLoad(selectedIndex);
        return 'handled';
      }

      if (activePane === 'detail-box') {
        scrollBox(detailBox, delta);
        context.screen.render();
        return 'handled';
      }

      selectedDeviceIndex = moveTableSelection({
        table: devicesTable,
        index: selectedDeviceIndex,
        delta,
        totalRows: devicesInSpace.length
      });
      renderState();
      return 'handled';
    },
    async handleKey(ch, key) {
      if (key.name === 'slash' || ch === '/') {
        const value = await context.prompt('Search spaces (empty clears):', searchText);
        if (value !== undefined) {
          searchText = value.trim();
          applyFilter();
          if (filtered.length) {
            clearSelectionDebounce();
            await loadSelection(selectedIndex);
          }
        }
        return true;
      }

      if (key.name === 'enter' && activePane === 'spaces-table') {
        clearSelectionDebounce();
        await loadSelection(selectedIndex);
        return true;
      }

      return false;
    }
  };
}
