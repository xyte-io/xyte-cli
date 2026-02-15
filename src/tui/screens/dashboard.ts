import blessed from 'blessed';

import { movePaneWithBoundary, scrollBox } from '../navigation';
import { SCREEN_PANE_CONFIG } from '../panes';
import type { TuiArrowKey, TuiContext, TuiPaneId, TuiScreen } from '../types';
import { loadDashboardData } from '../data-loaders';
import { sceneFromDashboardState } from '../scene';

function linesFromStats(stats: Array<{ label: string; value: string | number }> = []): string {
  return stats.map((item) => `${item.label}: ${item.value}`).join('\n');
}

function linesFromTableRows(rows: Array<Array<string | number>> = [], fallback: string): string {
  if (!rows.length) {
    return fallback;
  }
  return rows.map((row, index) => `${index + 1}. ${row[0]} | ${row[1]} | ${row[2]}`).join('\n');
}

export function createDashboardScreen(): TuiScreen {
  let root: blessed.Widgets.BoxElement | undefined;
  let kpis: blessed.Widgets.BoxElement | undefined;
  let incidentsBox: blessed.Widgets.BoxElement | undefined;
  let ticketsBox: blessed.Widgets.BoxElement | undefined;
  let providerBox: blessed.Widgets.BoxElement | undefined;
  let context: TuiContext;
  const paneConfig = SCREEN_PANE_CONFIG.dashboard;
  let activePane: TuiPaneId = paneConfig.defaultPane;

  const focusActivePane = () => {
    if (activePane === 'kpi') {
      kpis?.focus();
      return;
    }
    if (activePane === 'provider') {
      providerBox?.focus();
      return;
    }
    if (activePane === 'incidents') {
      incidentsBox?.focus();
      return;
    }
    ticketsBox?.focus();
  };

  return {
    id: 'dashboard',
    title: 'Dashboard',
    mount(parent, ctx) {
      context = ctx;
      root = blessed.box({
        parent,
        width: '100%-2',
        height: '100%-2',
        top: 0,
        left: 0
      });

      kpis = blessed.box({
        parent: root,
        top: 0,
        left: 0,
        width: '100%',
        height: 5,
        border: 'line',
        label: ' KPI ',
        keys: false,
        mouse: true
      });

      providerBox = blessed.box({
        parent: root,
        top: 5,
        left: 0,
        width: '100%',
        height: 4,
        border: 'line',
        label: ' Provider Status ',
        keys: false,
        mouse: true
      });

      incidentsBox = blessed.box({
        parent: root,
        top: 9,
        left: 0,
        width: '50%',
        height: '100%-9',
        border: 'line',
        label: ' Recent Incidents ',
        scrollable: true,
        alwaysScroll: true,
        keys: false,
        mouse: true,
        vi: true
      });

      ticketsBox = blessed.box({
        parent: root,
        top: 9,
        left: '50%',
        width: '50%',
        height: '100%-9',
        border: 'line',
        label: ' Recent Tickets ',
        scrollable: true,
        alwaysScroll: true,
        keys: false,
        mouse: true,
        vi: true
      });
      context.debugLog?.('nav.list.nativeKeysDisabled', {
        screen: 'dashboard',
        widgets: ['kpi', 'provider', 'incidents', 'tickets']
      });
    },
    unmount() {
      root?.destroy();
      root = undefined;
    },
    async refresh() {
      if (!root || !kpis || !incidentsBox || !ticketsBox || !providerBox) {
        return;
      }

      const tenantId = await context.getActiveTenantId();
      const providerOverride = context.getProviderOverride();
      const loaded = await loadDashboardData(context.client, tenantId);

      const panels = sceneFromDashboardState({
        tenantId,
        provider: providerOverride.provider,
        model: providerOverride.model,
        devices: loaded.data.devices,
        incidents: loaded.data.incidents,
        tickets: loaded.data.tickets
      });

      const kpiPanel = panels.find((panel) => panel.id === 'dashboard-kpis');
      const providerPanel = panels.find((panel) => panel.id === 'dashboard-provider');
      const incidentPanel = panels.find((panel) => panel.id === 'dashboard-incidents');
      const ticketPanel = panels.find((panel) => panel.id === 'dashboard-tickets');

      kpis.setContent(linesFromStats(kpiPanel?.stats));
      providerBox.setContent((providerPanel?.text?.lines ?? ['No provider state available.']).join('\n'));
      incidentsBox.setContent(linesFromTableRows(incidentPanel?.table?.rows, 'No incidents available for this tenant.'));
      ticketsBox.setContent(linesFromTableRows(ticketPanel?.table?.rows, 'No tickets available for this tenant.'));

      if (loaded.error) {
        context.setStatus(`Dashboard ${loaded.connectionState}: ${loaded.error.message}`);
      }

      context.screen.render();
      focusActivePane();
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
        focusActivePane();
        context.setStatus(`Pane: ${activePane}`);
        return 'handled';
      }

      if (key === 'up' || key === 'down') {
        const delta = key === 'up' ? -1 : 1;
        if (activePane === 'incidents') {
          scrollBox(incidentsBox, delta);
          context.screen.render();
          return 'handled';
        }
        if (activePane === 'tickets') {
          scrollBox(ticketsBox, delta);
          context.screen.render();
          return 'handled';
        }
      }

      return 'unhandled';
    }
  };
}
