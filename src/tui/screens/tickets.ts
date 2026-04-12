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
import type { EndpointNamespace } from '../../types/endpoints';
import { loadTicketsData } from '../data-loaders';
import { sceneFromTicketsState } from '../scene';
import { payloadSummary, safePreviewLines, safeSearchText } from '../serialize';
import { confirmWriteWithToken, openActionPalette, runGuardedAction } from '../actions';
import { asRecord } from '../../utils/json';
import { errorMessage } from '../../utils/error-format';

function renderTicketFallbackTable(
  list: blessed.Widgets.ListTableElement | undefined,
  filtered: unknown[],
  selectionSync: SelectionSyncState
): void {
  if (!list) return;
  setListTableData(
    list,
    [
      ['ID', 'Status', 'Priority', 'Subject'],
      ...filtered.map((ticket, index) => {
        const r = asRecord(ticket);
        return [
          String(r.id ?? r._id ?? `row-${index + 1}`),
          String(r.status ?? r.state ?? 'unknown'),
          String(r.priority ?? 'n/a'),
          String(r.subject ?? r.title ?? 'n/a')
        ];
      })
    ],
    selectionSync
  );
}

function ticketIdOf(ticket: unknown): string {
  const r = asRecord(ticket);
  return String(r.id ?? r._id ?? '');
}

function ticketStatusOf(ticket: unknown): string {
  const r = asRecord(ticket);
  return String(r.status ?? r.state ?? '')
    .trim()
    .toLowerCase();
}

function ticketPriorityOf(ticket: unknown): string {
  const r = asRecord(ticket);
  return String(r.priority ?? '')
    .trim()
    .toLowerCase();
}

interface ResolveTicketWithGuardArgs {
  ticket: unknown;
  mode: EndpointNamespace;
  context: Pick<TuiContext, 'confirmWrite' | 'setStatus' | 'showError' | 'getActiveTenantId' | 'client'>;
}

export async function markTicketResolvedWithGuard(args: ResolveTicketWithGuardArgs): Promise<boolean> {
  const { ticket, mode, context } = args;
  if (mode !== 'organization') {
    context.setStatus('Ticket write actions are disabled in partner mode (organization-only policy).');
    return false;
  }

  const ticketId = ticketIdOf(ticket);
  if (!ticketId) {
    context.setStatus('Selected ticket has no id.');
    return false;
  }

  const ok = await confirmWriteWithToken({
    context,
    actionLabel: 'Resolve ticket',
    token: 'resolve',
    cancelStatus: 'Resolve action canceled.'
  });
  if (!ok) {
    return false;
  }

  return runGuardedAction(context, 'Resolving ticket...', async (tenantId) => {
    await context.client.organization.markResolved({ tenantId, path: { ticket_id: ticketId } });
    context.setStatus(`Ticket ${ticketId} resolved.`);
  });
}

interface SendTicketMessageWithGuardArgs {
  ticket: unknown;
  mode: EndpointNamespace;
  context: Pick<TuiContext, 'confirmWrite' | 'setStatus' | 'showError' | 'getActiveTenantId' | 'client'>;
  message: string;
}

export async function sendTicketMessageWithGuard(args: SendTicketMessageWithGuardArgs): Promise<boolean> {
  const { ticket, mode, context } = args;
  if (mode !== 'organization') {
    context.setStatus('Ticket write actions are disabled in partner mode (organization-only policy).');
    return false;
  }

  const ticketId = ticketIdOf(ticket);
  if (!ticketId) {
    context.setStatus('Selected ticket has no id.');
    return false;
  }

  const message = args.message.trim();
  if (!message) {
    context.setStatus('Message is required.');
    return false;
  }

  const ok = await confirmWriteWithToken({
    context,
    actionLabel: 'Send ticket message',
    token: 'message',
    cancelStatus: 'Send message canceled.'
  });
  if (!ok) {
    return false;
  }

  return runGuardedAction(context, 'Sending ticket message...', async (tenantId) => {
    await context.client.organization.sendMessage({
      tenantId,
      path: { ticket_id: ticketId },
      query: { message }
    });
    context.setStatus(`Message sent for ticket ${ticketId}.`);
  });
}

export function createTicketsScreen(): NavigableScreen {
  let root: blessed.Widgets.BoxElement | undefined;
  let list: blessed.Widgets.ListTableElement | undefined;
  let detail: blessed.Widgets.BoxElement | undefined;
  let context: TuiContext;
  let tickets: unknown[] = [];
  let filteredAll: unknown[] = [];
  let filtered: unknown[] = [];
  let mode: EndpointNamespace = 'organization';
  let searchText = '';
  let statusFilter = '';
  let priorityFilter = '';
  let page = 1;
  let perPage = 25;
  let selectedIndex = 0;
  let detailText = '';
  let lastResolveTapAt = 0;
  let detailRequestToken = 0;
  let selectionSync: SelectionSyncState = {
    syncing: false,
    name: 'tickets-table'
  };
  const paneConfig = SCREEN_PANE_CONFIG.tickets;
  let activePane: TuiPaneId = paneConfig.defaultPane;
  let isMounted = false;
  const renderErrors = createRenderErrorTracker();
  const renderLog = createScreenRenderLogger('tickets', () => context.debugLog, renderErrors);
  const detailCacheByTicket = new Map<string, string>();

  const focusPane = () => {
    if (activePane === 'tickets-table') {
      list?.focus();
      return;
    }
    detail?.focus();
  };

  const selectedTicket = () => filtered[selectedIndex];
  const ticketWritesEnabled = () => mode === 'organization';

  const rebuildFiltered = (restoreTicketId?: string) => {
    let next = tickets;
    if (searchText) {
      const needle = searchText.toLowerCase();
      next = next.filter((ticket) => safeSearchText(ticket).includes(needle));
    }
    if (statusFilter) {
      next = next.filter((ticket) => ticketStatusOf(ticket).includes(statusFilter));
    }
    if (priorityFilter) {
      next = next.filter((ticket) => ticketPriorityOf(ticket).includes(priorityFilter));
    }
    filteredAll = next;

    const totalPages = Math.max(1, Math.ceil(Math.max(filteredAll.length, 1) / Math.max(1, perPage)));
    if (restoreTicketId) {
      const globalIndex = filteredAll.findIndex((ticket) => ticketIdOf(ticket) === restoreTicketId);
      if (globalIndex >= 0) {
        page = Math.floor(globalIndex / Math.max(1, perPage)) + 1;
      }
    }
    page = Math.max(1, Math.min(page, totalPages));
    const start = (page - 1) * Math.max(1, perPage);
    filtered = filteredAll.slice(start, start + Math.max(1, perPage));

    const pageIndex = restoreTicketId
      ? filtered.findIndex((ticket) => ticketIdOf(ticket) === restoreTicketId)
      : -1;
    selectedIndex = pageIndex >= 0 ? pageIndex : clampIndex(selectedIndex, filtered.length);
  };

  const renderRows = (restoreTicketId?: string) => {
    if (!isMounted) {
      return;
    }
    renderLog.onRenderStart();
    rebuildFiltered(restoreTicketId);

    const actionsHint = ticketWritesEnabled()
      ? 'actions: a open action palette'
      : 'actions: writes disabled in partner mode';

    try {
      if (renderErrors.frozen) {
        renderTicketFallbackTable(list, filtered, selectionSync);
        detail?.setContent('Render fallback mode enabled for ticket details.');
      } else {
        const panels = sceneFromTicketsState({
          mode,
          searchText,
          selectedIndex,
          tickets: filtered,
          detailText,
          statusFilter,
          priorityFilter,
          page,
          perPage,
          totalFiltered: filteredAll.length,
          actionsHint
        });

        const tablePanel = panels.find((panel) => panel.id === 'tickets-table');
        const detailPanel = panels.find((panel) => panel.id === 'tickets-detail');

        setListTableData(
          list,
          [
            (tablePanel?.table?.columns ?? ['ID', 'Status', 'Priority', 'Subject']) as [string, string, string, string],
            ...((tablePanel?.table?.rows ?? []) as Array<[string, string, string, string]>)
          ],
          selectionSync
        );
        detail?.setContent((detailPanel?.text?.lines ?? ['No tickets.']).join('\n'));
      }
      renderErrors.recordSuccess();
      renderLog.onRenderComplete();
    } catch (error) {
      const message = errorMessage(error);
      renderErrors.recordError(message);
      renderLog.onRenderError(message);
      renderTicketFallbackTable(list, filtered, selectionSync);
      detail?.setContent(`Unable to render ticket detail safely.\nReason: ${message}`);
    }
    syncListSelection(list, selectedIndex, selectionSync);
    focusPane();
  };

  const queueTicketDetailFetch = (index: number) => {
    if (!isMounted) {
      return;
    }
    selectedIndex = clampIndex(index, filtered.length);
    const ticket = selectedTicket();
    if (!ticket) {
      detailText = '';
      renderRows();
      context.screen.render();
      return;
    }

    const ticketId = ticketIdOf(ticket);
    const fallbackPreview = safePreviewLines(ticket).lines.join('\n');
    detailText = ticketId && detailCacheByTicket.has(ticketId) ? detailCacheByTicket.get(ticketId)! : fallbackPreview;
    renderRows();
    context.screen.render();
    if (!ticketId) {
      return;
    }

    const requestToken = ++detailRequestToken;
    void (async () => {
      try {
        const tenantId = await context.getActiveTenantId();
        const full =
          mode === 'organization'
            ? await context.client.organization.getTicket({ tenantId, path: { ticket_id: ticketId } })
            : await context.client.partner.getTicket({ tenantId, path: { ticket_id: ticketId } });
        if (!isMounted || requestToken !== detailRequestToken || selectedIndex !== index) {
          return;
        }
        detailText = safePreviewLines(full).lines.join('\n');
        detailCacheByTicket.set(ticketId, detailText);
        renderRows(ticketId);
        context.screen.render();
      } catch {
        if (!isMounted || requestToken !== detailRequestToken || selectedIndex !== index) {
          return;
        }
        const cached = detailCacheByTicket.get(ticketId);
        detailText = cached
          ? `${cached}\n\n[warning] Unable to refresh full ticket details; showing last successful preview.`
          : `${fallbackPreview}\n\n[warning] Unable to refresh full ticket details.`;
        renderRows(ticketId);
        context.screen.render();
      }
    })();
  };

  return {
    id: 'tickets',
    title: 'Tickets',
    mount(parent, ctx) {
      context = ctx;
      selectionSync = {
        syncing: false,
        name: 'tickets-table',
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
        width: '50%',
        height: '100%',
        border: 'line',
        label: ' Tickets ',
        keys: false,
        mouse: true,
        data: [['ID', 'Status', 'Priority', 'Subject']],
        style: {
          header: { bold: true, fg: 'black', bg: 'white' },
          cell: { selected: { bg: 'blue' } }
        }
      });

      detail = blessed.box({
        parent: root,
        top: 0,
        left: '50%',
        width: '50%',
        height: '100%',
        border: 'line',
        label: ' Ticket Detail ',
        scrollable: true,
        alwaysScroll: true,
        keys: false,
        mouse: true,
        vi: true,
        content: 'Select a ticket.'
      });

      context.debugLog?.('nav.list.nativeKeysDisabled', {
        screen: 'tickets',
        widgets: ['tickets-table', 'detail-box']
      });

      list.on('select item', (_item: unknown, index: number) => {
        if (shouldIgnoreSelectEvent(selectionSync)) {
          return;
        }
        queueTicketDetailFetch(Math.max(0, index - 1));
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
      const restoreTicketId = ticketIdOf(selectedTicket());
      logScreenDataFetch(context.debugLog, 'tickets', 'start', { tenantId });
      const loaded = await loadTicketsData(context.client, tenantId);
      if (!isMounted) {
        return;
      }

      mode = loaded.data.mode;
      tickets = loaded.data.tickets;
      detailRequestToken += 1;
      detailCacheByTicket.clear();
      detailText = '';
      logScreenDataFetch(context.debugLog, 'tickets', 'complete', {
        tenantId,
        count: tickets.length,
        mode,
        connectionState: loaded.connectionState,
        retry: loaded.retry,
        payload: payloadSummary(tickets)
      });
      if (loaded.error) {
        context.setStatus(`Tickets ${loaded.connectionState}: ${loaded.error.message}`);
        logScreenDataFetch(context.debugLog, 'tickets', 'error', { message: loaded.error.message, state: loaded.connectionState });
      }
      renderRows(restoreTicketId);
      if (filtered.length) {
        queueTicketDetailFetch(selectedIndex);
      }
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

      if (activePane === 'tickets-table') {
        const beforeIndex = selectedIndex;
        selectedIndex = moveTableSelection({
          table: list,
          index: selectedIndex,
          delta,
          totalRows: filtered.length,
          selectionSync
        });
        context.debugLog?.('nav.arrow.updown', {
          screen: 'tickets',
          pane: activePane,
          beforeIndex,
          afterIndex: selectedIndex,
          delta
        });
        queueTicketDetailFetch(selectedIndex);
        return 'handled';
      }

      if (activePane === 'detail-box') {
        scrollBox(detail, delta);
        context.screen.render();
        return 'handled';
      }
      return 'unhandled';
    },
    async handleKey(ch, key) {
      const resolveSelected = async () => {
        const ticket = selectedTicket();
        if (!ticket) {
          context.setStatus('No ticket selected.');
          return true;
        }
        const resolved = await markTicketResolvedWithGuard({ ticket, mode, context });
        if (!isMounted) {
          return true;
        }
        if (resolved) {
          await this.refresh();
        }
        return true;
      };

      const sendMessage = async () => {
        const ticket = selectedTicket();
        if (!ticket) {
          context.setStatus('No ticket selected.');
          return true;
        }
        const message = await context.prompt('Ticket message:', '');
        if (message === undefined) {
          context.setStatus('Send message canceled.');
          return true;
        }
        const sent = await sendTicketMessageWithGuard({
          ticket,
          mode,
          context,
          message
        });
        if (sent && isMounted) {
          await this.refresh();
        }
        return true;
      };

      if (key.name === 'slash' || ch === '/') {
        const value = await context.prompt('Search tickets (empty clears):', searchText);
        if (!isMounted) {
          return true;
        }
        if (value !== undefined) {
          searchText = value.trim();
          page = 1;
          selectedIndex = 0;
          renderRows();
          if (filtered.length) {
            queueTicketDetailFetch(selectedIndex);
          } else {
            context.screen.render();
          }
        }
        return true;
      }

      if (ch === 'f') {
        const status = await context.prompt('Status filter (empty clears):', statusFilter);
        if (status === undefined || !isMounted) {
          return true;
        }
        const priority = await context.prompt('Priority filter (empty clears):', priorityFilter);
        if (priority === undefined || !isMounted) {
          return true;
        }
        statusFilter = status.trim().toLowerCase();
        priorityFilter = priority.trim().toLowerCase();
        page = 1;
        selectedIndex = 0;
        renderRows();
        if (filtered.length) {
          queueTicketDetailFetch(selectedIndex);
        } else {
          context.screen.render();
        }
        return true;
      }

      if (ch === '[') {
        page = Math.max(1, page - 1);
        selectedIndex = 0;
        renderRows();
        if (filtered.length) {
          queueTicketDetailFetch(0);
        } else {
          context.screen.render();
        }
        return true;
      }

      if (ch === ']') {
        page += 1;
        selectedIndex = 0;
        renderRows();
        if (filtered.length) {
          queueTicketDetailFetch(0);
        } else {
          context.screen.render();
        }
        return true;
      }

      if (ch === 'p') {
        const value = await context.prompt('Tickets per page (10|25|50|100):', String(perPage));
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
        renderRows();
        if (filtered.length) {
          queueTicketDetailFetch(0);
        } else {
          context.screen.render();
        }
        return true;
      }

      if (ch === 'a') {
        await openActionPalette({
          context,
          title: `Ticket actions (${mode} mode)`,
          actions: [
            {
              label: 'Resolve ticket',
              enabled: ticketWritesEnabled(),
              disabledReason: 'Ticket writes are disabled in partner mode.',
              run: async () => resolveSelected()
            },
            {
              label: 'Send message',
              enabled: ticketWritesEnabled(),
              disabledReason: 'Ticket writes are disabled in partner mode.',
              run: async () => sendMessage()
            }
          ]
        });
        return true;
      }

      if (ch === 'R') {
        return resolveSelected();
      }

      if (ch === 'r') {
        const now = Date.now();
        const tappedTwiceQuickly = now - lastResolveTapAt <= 650;
        lastResolveTapAt = now;
        if (tappedTwiceQuickly) {
          return resolveSelected();
        }
        return false;
      }

      if (key.name === 'enter' && activePane === 'tickets-table') {
        queueTicketDetailFetch(selectedIndex);
        return true;
      }

      return false;
    }
  };
}
