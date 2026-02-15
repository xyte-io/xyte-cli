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
import { loadIncidentsData } from '../data-loaders';
import { sceneFromIncidentsState } from '../scene';
import { payloadSummary } from '../serialize';

export function normalizeIncidents(items: unknown): any[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .filter((incident) => incident !== null && incident !== undefined)
    .map((incident) => (typeof incident === 'object' ? incident : { value: incident }));
}

export function formatIncidentTriageText(triage: {
  rootCauseHypothesis?: string;
  confidence?: number;
  recommendedNextActions?: unknown[];
  escalationHint?: string;
}): string {
  const actions = Array.isArray(triage.recommendedNextActions)
    ? triage.recommendedNextActions.map((item) => String(item))
    : [];
  const confidence = typeof triage.confidence === 'number' && Number.isFinite(triage.confidence) ? triage.confidence : 0;

  return [
    `Root cause: ${triage.rootCauseHypothesis ?? 'unknown'}`,
    `Confidence: ${confidence.toFixed(2)}`,
    'Next actions:',
    ...(actions.length ? actions.map((item) => `- ${item}`) : ['- none']),
    `Escalation: ${triage.escalationHint ?? 'none'}`
  ].join('\n');
}

export function createIncidentsScreen(): TuiScreen {
  let root: blessed.Widgets.BoxElement | undefined;
  let list: blessed.Widgets.ListTableElement | undefined;
  let triageBox: blessed.Widgets.BoxElement | undefined;
  let detailBox: blessed.Widgets.BoxElement | undefined;
  let context: TuiContext;
  let incidents: any[] = [];
  let filtered: any[] = [];
  let severityFilter = '';
  let selectedIndex = 0;
  let triageText = '';
  let selectionSync: SelectionSyncState = {
    syncing: false,
    name: 'incidents-table'
  };
  const paneConfig = SCREEN_PANE_CONFIG.incidents;
  let activePane: TuiPaneId = paneConfig.defaultPane;
  let isMounted = false;
  let renderErrorMessage = '';
  let renderErrorCount = 0;
  let renderErrorWindowStart = 0;
  let renderFrozen = false;

  const focusPane = () => {
    if (activePane === 'incidents-table') {
      list?.focus();
      return;
    }
    if (activePane === 'detail-box') {
      detailBox?.focus();
      return;
    }
    triageBox?.focus();
  };

  const renderRows = () => {
    if (!isMounted) {
      return;
    }
    context.debugLog?.('screen.render.start', {
      screen: 'incidents',
      frozen: renderFrozen
    });
    filtered = severityFilter
      ? incidents.filter((incident) => String(incident?.severity ?? incident?.priority ?? '').toLowerCase().includes(severityFilter))
      : incidents;
    selectedIndex = clampIndex(selectedIndex, filtered.length);

    try {
      if (renderFrozen) {
        setListTableData(list, [
          ['ID', 'Severity', 'State', 'Device'],
          ...filtered.map((incident, index) => [
            String(incident?.id ?? incident?._id ?? incident?.uuid ?? `row-${index + 1}`),
            String(incident?.severity ?? incident?.priority ?? 'unknown'),
            String(incident?.status ?? incident?.state ?? 'unknown'),
            String(incident?.device_id ?? incident?.device?.id ?? 'n/a')
          ])
        ], selectionSync);
        detailBox?.setContent('Render fallback mode enabled for incident details.');
        triageBox?.setContent('Triage view suspended due to repeated render failures. Press r to retry.');
      } else {
        const panels = sceneFromIncidentsState({
          severityFilter,
          selectedIndex,
          incidents: filtered,
          triageText
        });

        const tablePanel = panels.find((panel) => panel.id === 'incidents-table');
        const detailPanel = panels.find((panel) => panel.id === 'incidents-detail');
        const triagePanel = panels.find((panel) => panel.id === 'incidents-triage');

        setListTableData(list, [
          (tablePanel?.table?.columns ?? ['ID', 'Severity', 'State', 'Device']) as [string, string, string, string],
          ...((tablePanel?.table?.rows ?? []) as Array<[string, string, string, string]>)
        ], selectionSync);
        detailBox?.setContent((detailPanel?.text?.lines ?? ['No incidents.']).join('\n'));
        triageBox?.setContent((triagePanel?.text?.lines ?? ['Run triage with key x.']).join('\n'));
      }
      renderErrorMessage = '';
      renderErrorCount = 0;
      renderErrorWindowStart = 0;
      context.debugLog?.('screen.render.complete', {
        screen: 'incidents',
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
        screen: 'incidents',
        message,
        count: renderErrorCount,
        frozen: renderFrozen
      });
      context.debugLog?.('screen.render.fallback.applied', {
        screen: 'incidents'
      });
      setListTableData(list, [
        ['ID', 'Severity', 'State', 'Device'],
        ...filtered.map((incident, index) => [
          String(incident?.id ?? incident?._id ?? incident?.uuid ?? `row-${index + 1}`),
          String(incident?.severity ?? incident?.priority ?? 'unknown'),
          String(incident?.status ?? incident?.state ?? 'unknown'),
          String(incident?.device_id ?? incident?.device?.id ?? 'n/a')
        ])
      ], selectionSync);
      detailBox?.setContent(`Unable to render incident detail safely.\nReason: ${message}`);
      triageBox?.setContent('Run triage with key x.');
    }
    syncListSelection(list, selectedIndex, selectionSync);
    focusPane();
  };

  return {
    id: 'incidents',
    title: 'Incidents',
    mount(parent, ctx) {
      context = ctx;
      selectionSync = {
        syncing: false,
        name: 'incidents-table',
        onLog: (event, data) => context.debugLog?.(event, data)
      };
      isMounted = true;
      root = blessed.box({
        parent,
        width: '100%-2',
        height: '100%-2'
      });

      list = blessed.listtable({
        parent: root,
        top: 0,
        left: 0,
        width: '45%',
        height: '100%',
        border: 'line',
        label: ' Incidents ',
        keys: false,
        mouse: true,
        data: [['ID', 'Severity', 'State', 'Device']],
        style: {
          header: { bold: true, fg: 'black', bg: 'white' },
          cell: { selected: { bg: 'blue' } }
        }
      });

      detailBox = blessed.box({
        parent: root,
        top: 0,
        left: '45%',
        width: '25%',
        height: '100%',
        border: 'line',
        label: ' Incident Detail ',
        scrollable: true,
        alwaysScroll: true,
        keys: false,
        mouse: true,
        vi: true
      });

      triageBox = blessed.box({
        parent: root,
        top: 0,
        left: '70%',
        width: '30%',
        height: '100%',
        border: 'line',
        label: ' Triage ',
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        vi: true,
        keys: false,
        mouse: true,
        content: 'Select an incident and press x to run triage.'
      });
      context.debugLog?.('nav.list.nativeKeysDisabled', {
        screen: 'incidents',
        widgets: ['incidents-table', 'detail-box', 'triage-box']
      });

      list.on('select item', (_item, index) => {
        if (shouldIgnoreSelectEvent(selectionSync)) {
          return;
        }
        selectedIndex = Math.max(0, index - 1);
        renderRows();
        context.screen.render();
      });
    },
    unmount() {
      isMounted = false;
      root?.destroy();
      root = undefined;
    },
    async refresh() {
      if (!isMounted) {
        return;
      }
      const tenantId = await context.getActiveTenantId();
      context.debugLog?.('screen.data.fetch.start', {
        screen: 'incidents',
        tenantId
      });
      const loaded = await loadIncidentsData(context.client, tenantId);
      if (!isMounted) {
        return;
      }
      incidents = normalizeIncidents(loaded.data);
      context.debugLog?.('screen.data.fetch.complete', {
        screen: 'incidents',
        tenantId,
        count: incidents.length,
        connectionState: loaded.connectionState,
        retry: loaded.retry,
        payload: payloadSummary(incidents)
      });
      if (loaded.error) {
        context.setStatus(`Incidents ${loaded.connectionState}: ${loaded.error.message}`);
        context.debugLog?.('screen.data.fetch.error', {
          screen: 'incidents',
          message: loaded.error.message,
          state: loaded.connectionState
        });
      }
      renderRows();
      context.screen.render();
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

      if (activePane === 'incidents-table') {
        const beforeIndex = selectedIndex;
        selectedIndex = moveTableSelection({
          table: list,
          index: selectedIndex,
          delta,
          totalRows: filtered.length,
          selectionSync
        });
        context.debugLog?.('nav.arrow.updown', {
          screen: 'incidents',
          pane: activePane,
          beforeIndex,
          afterIndex: selectedIndex,
          delta
        });
        renderRows();
        context.screen.render();
        return 'handled';
      }

      if (activePane === 'detail-box') {
        scrollBox(detailBox, delta);
        context.screen.render();
        return 'handled';
      }

      scrollBox(triageBox, delta);
      context.screen.render();
      return 'handled';
    },
    async handleKey(ch, key) {
      if (key.name === 'slash' || ch === '/') {
        const value = await context.prompt('Severity filter (e.g. high/critical):', severityFilter);
        if (!isMounted) {
          return true;
        }
        if (value !== undefined) {
          severityFilter = value.trim().toLowerCase();
          selectedIndex = 0;
          renderRows();
          context.screen.render();
        }
        return true;
      }

      if (ch === 'x') {
        const selected = filtered[selectedIndex];
        if (!selected) {
          context.setStatus('No incident selected.');
          return true;
        }

        context.setStatus('Running incident triage...');
        try {
          const triage = await context.runIncidentTriage({ incident: selected });
          if (!isMounted) {
            return true;
          }
          triageText = formatIncidentTriageText(triage);
          renderRows();
          context.setStatus('Incident triage complete.');
          context.screen.render();
        } catch (error) {
          context.showError(error);
        }

        return true;
      }

      if (key.name === 'enter' && activePane === 'incidents-table') {
        renderRows();
        context.screen.render();
        return true;
      }

      return false;
    }
  };
}
