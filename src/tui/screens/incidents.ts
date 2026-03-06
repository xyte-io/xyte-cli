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
import { confirmWriteWithToken, openActionPalette } from '../actions';

function incidentIdOf(incident: any): string {
  return String(incident?.id ?? incident?._id ?? incident?.uuid ?? '');
}

interface CloseIncidentWithGuardArgs {
  incident: any;
  context: Pick<TuiContext, 'confirmWrite' | 'setStatus' | 'showError' | 'getActiveTenantId' | 'client'>;
}

export async function closeIncidentWithGuard(args: CloseIncidentWithGuardArgs): Promise<boolean> {
  const incidentId = incidentIdOf(args.incident);
  if (!incidentId) {
    args.context.setStatus('Selected incident has no id.');
    return false;
  }

  const ok = await confirmWriteWithToken(args.context, 'Close incident', 'close', 'Close incident canceled.');
  if (!ok) {
    return false;
  }

  args.context.setStatus('Closing incident...');
  try {
    const tenantId = await args.context.getActiveTenantId();
    await args.context.client.organization.closeIncident({
      tenantId,
      path: { incident_id: incidentId }
    });
    args.context.setStatus(`Incident ${incidentId} closed.`);
    return true;
  } catch (error) {
    args.context.showError(error);
    return false;
  }
}

export function normalizeIncidents(items: unknown): any[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .filter((incident) => incident !== null && incident !== undefined)
    .map((incident) => (typeof incident === 'object' ? incident : { value: incident }));
}

export function createIncidentsScreen(): TuiScreen {
  let root: blessed.Widgets.BoxElement | undefined;
  let list: blessed.Widgets.ListTableElement | undefined;
  let detailBox: blessed.Widgets.BoxElement | undefined;
  let context: TuiContext;
  let incidents: any[] = [];
  let filtered: any[] = [];
  let severityFilter = '';
  let selectedIndex = 0;
  let statusFilter = 'active';
  let priorityFilter = '';
  let spaceIdFilter = '';
  let titleFilter = '';
  let issueFilter = '';
  let page = 1;
  let perPage = 100;
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
    detailBox?.focus();
  };

  const selectedIncident = () => filtered[selectedIndex];

  const renderRows = (restoreIncidentId?: string) => {
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

    if (restoreIncidentId) {
      const restoreIndex = filtered.findIndex((incident) => incidentIdOf(incident) === restoreIncidentId);
      selectedIndex = restoreIndex >= 0 ? restoreIndex : clampIndex(selectedIndex, filtered.length);
    } else {
      selectedIndex = clampIndex(selectedIndex, filtered.length);
    }

    const actionsHint = 'actions: a close-incident, f filters, [ ] pages, p per-page';

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
      } else {
        const panels = sceneFromIncidentsState({
          severityFilter,
          selectedIndex,
          incidents: filtered,
          statusFilter,
          priorityFilter,
          page,
          perPage,
          actionsHint
        });

        const tablePanel = panels.find((panel) => panel.id === 'incidents-table');
        const detailPanel = panels.find((panel) => panel.id === 'incidents-detail');

        setListTableData(list, [
          (tablePanel?.table?.columns ?? ['ID', 'Severity', 'State', 'Device']) as [string, string, string, string],
          ...((tablePanel?.table?.rows ?? []) as Array<[string, string, string, string]>)
        ], selectionSync);
        detailBox?.setContent((detailPanel?.text?.lines ?? ['No incidents.']).join('\n'));
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
    }
    syncListSelection(list, selectedIndex, selectionSync);
    focusPane();
  };

  const refreshRows = async (restoreIncidentId?: string) => {
    if (!isMounted) {
      return;
    }
    const tenantId = await context.getActiveTenantId();
    context.debugLog?.('screen.data.fetch.start', {
      screen: 'incidents',
      tenantId
    });
    const loaded = await loadIncidentsData(context.client, tenantId, {
      paginateAll: false,
      query: {
        status: statusFilter || undefined,
        priority: priorityFilter || undefined,
        space_id: spaceIdFilter || undefined,
        title: titleFilter || undefined,
        issue: issueFilter || undefined,
        from: 0,
        to: Math.floor(Date.now() / 1000),
        page,
        per_page: perPage
      }
    });
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
      payload: payloadSummary(incidents),
      page,
      perPage
    });
    if (loaded.error) {
      context.setStatus(`Incidents ${loaded.connectionState}: ${loaded.error.message}`);
      context.debugLog?.('screen.data.fetch.error', {
        screen: 'incidents',
        message: loaded.error.message,
        state: loaded.connectionState
      });
    }
    renderRows(restoreIncidentId);
    context.screen.render();
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
        width: '55%',
        height: '100%',
        border: 'line',
        label: ' Incident Detail ',
        scrollable: true,
        alwaysScroll: true,
        keys: false,
        mouse: true,
        vi: true
      });

      context.debugLog?.('nav.list.nativeKeysDisabled', {
        screen: 'incidents',
        widgets: ['incidents-table', 'detail-box']
      });

      list.on('select item', (_item: unknown, index: number) => {
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
      await refreshRows(incidentIdOf(selectedIncident()));
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
      return 'unhandled';
    },
    async handleKey(ch, key) {
      if (key.name === 'slash' || ch === '/') {
        const value = await context.prompt('Severity filter (local; empty clears):', severityFilter);
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

      if (ch === 'f') {
        const nextStatus = await context.prompt('Status filter (empty clears):', statusFilter);
        if (nextStatus === undefined || !isMounted) {
          return true;
        }
        const nextPriority = await context.prompt('Priority filter (empty clears):', priorityFilter);
        if (nextPriority === undefined || !isMounted) {
          return true;
        }
        const nextSpaceId = await context.prompt('Space ID filter (empty clears):', spaceIdFilter);
        if (nextSpaceId === undefined || !isMounted) {
          return true;
        }
        const nextTitle = await context.prompt('Title filter (empty clears):', titleFilter);
        if (nextTitle === undefined || !isMounted) {
          return true;
        }
        const nextIssue = await context.prompt('Issue filter (empty clears):', issueFilter);
        if (nextIssue === undefined || !isMounted) {
          return true;
        }

        statusFilter = nextStatus.trim().toLowerCase();
        priorityFilter = nextPriority.trim().toLowerCase();
        spaceIdFilter = nextSpaceId.trim();
        titleFilter = nextTitle.trim();
        issueFilter = nextIssue.trim();
        page = 1;
        selectedIndex = 0;
        await refreshRows();
        return true;
      }

      if (ch === '[') {
        page = Math.max(1, page - 1);
        selectedIndex = 0;
        await refreshRows();
        return true;
      }

      if (ch === ']') {
        page += 1;
        selectedIndex = 0;
        await refreshRows();
        return true;
      }

      if (ch === 'p') {
        const value = await context.prompt('Incidents per page (10|25|50|100):', String(perPage));
        if (value === undefined || !isMounted) {
          return true;
        }
        const parsed = Number.parseInt(value.trim(), 10);
        if (![10, 25, 50, 100].includes(parsed)) {
          context.setStatus('Invalid per-page value. Use 10, 25, 50, or 100.');
          return true;
        }
        perPage = parsed;
        page = 1;
        selectedIndex = 0;
        await refreshRows();
        return true;
      }

      if (ch === 'a') {
        return openActionPalette({
          context,
          title: 'Incident actions',
          actions: [
            {
              label: 'Close incident',
              run: async () => {
                const incident = selectedIncident();
                if (!incident) {
                  context.setStatus('No incident selected.');
                  return;
                }
                const closed = await closeIncidentWithGuard({
                  incident,
                  context
                });
                if (closed && isMounted) {
                  await refreshRows();
                }
              }
            }
          ]
        });
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
