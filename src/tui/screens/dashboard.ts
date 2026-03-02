import blessed, { type Widgets } from 'blessed';

import { movePaneWithBoundary, scrollBox } from '../navigation';
import { SCREEN_PANE_CONFIG } from '../panes';
import type { TuiArrowKey, TuiContext, TuiPaneId, TuiScreen } from '../types';
import { loadDashboardData } from '../data-loaders';
import { sceneFromDashboardState } from '../scene';
import { safeInspect } from '../serialize';

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
  let root: Widgets.BoxElement | undefined;
  let kpis: Widgets.BoxElement | undefined;
  let incidentsBox: Widgets.BoxElement | undefined;
  let ticketsBox: Widgets.BoxElement | undefined;
  let providerBox: Widgets.BoxElement | undefined;
  let context: TuiContext;
  const paneConfig = SCREEN_PANE_CONFIG.dashboard;
  let activePane: TuiPaneId = paneConfig.defaultPane;
  let lastIncidents: any[] = [];
  let lastTickets: any[] = [];
  let lastDevicesCount = 0;

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
      const loaded = await loadDashboardData(context.client, tenantId);
      lastIncidents = loaded.data.incidents ?? [];
      lastTickets = loaded.data.tickets ?? [];
      lastDevicesCount = loaded.data.devices.length;

      const panels = sceneFromDashboardState({
        tenantId,
        devices: loaded.data.devices,
        incidents: loaded.data.incidents,
        tickets: loaded.data.tickets
      });

      const kpiPanel = panels.find((panel) => panel.id === 'dashboard-kpis');
      const providerPanel = panels.find((panel) => panel.id === 'dashboard-status');
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
    getCtaHints() {
      return [
        'Enter drills into incidents or tickets pane',
        'Ctrl+←/→ moves pane focus',
        'o deep details'
      ];
    },
    getEntityDetails() {
      if (activePane === 'incidents' && lastIncidents.length) {
        const inspected = safeInspect(lastIncidents[0], {
          maxDepth: 6,
          maxArrayItems: 60,
          maxObjectKeys: 120,
          maxOutputChars: 8_000
        });
        return {
          title: 'Top incident from dashboard',
          content: inspected.text,
          hint: 'Press Enter to open full incidents screen.'
        };
      }
      if (activePane === 'tickets' && lastTickets.length) {
        const inspected = safeInspect(lastTickets[0], {
          maxDepth: 6,
          maxArrayItems: 60,
          maxObjectKeys: 120,
          maxOutputChars: 8_000
        });
        return {
          title: 'Top ticket from dashboard',
          content: inspected.text,
          hint: 'Press Enter to open full tickets screen.'
        };
      }
      const inspected = safeInspect(
        {
          activePane,
          devices: lastDevicesCount,
          incidents: lastIncidents.length,
          tickets: lastTickets.length
        },
        {
          maxDepth: 4,
          maxArrayItems: 20,
          maxObjectKeys: 40,
          maxOutputChars: 3_000
        }
      );
      return {
        title: 'Dashboard summary',
        content: inspected.text,
        hint: 'Move to incidents or tickets pane for entity-level details.'
      };
    },
    getEnterTargetScreen() {
      if (activePane === 'incidents') {
        return 'incidents';
      }
      if (activePane === 'tickets') {
        return 'tickets';
      }
      return undefined;
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
