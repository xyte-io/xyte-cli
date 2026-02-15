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
import { loadTicketsData } from '../data-loaders';
import { sceneFromTicketsState } from '../scene';
import { payloadSummary, safePreviewLines, safeSearchText } from '../serialize';

export interface ResolveTicketWithGuardArgs {
  ticket: any;
  mode: 'organization' | 'partner';
  context: Pick<TuiContext, 'confirmWrite' | 'setStatus' | 'showError' | 'getActiveTenantId' | 'client'>;
}

export async function resolveTicketWithGuard(args: ResolveTicketWithGuardArgs): Promise<boolean> {
  const { ticket, mode, context } = args;
  const ok = await context.confirmWrite('Resolve ticket', 'resolve');
  if (!ok) {
    context.setStatus('Resolve action canceled.');
    return false;
  }

  const ticketId = String(ticket?.id ?? ticket?._id ?? '');
  if (!ticketId) {
    context.setStatus('Selected ticket has no id.');
    return false;
  }

  context.setStatus('Resolving ticket...');
  try {
    const tenantId = await context.getActiveTenantId();
    if (mode === 'organization') {
      await context.client.organization.markResolved({ tenantId, path: { ticket_id: ticketId } });
    } else {
      await context.client.partner.closeTicket({ tenantId, path: { ticket_id: ticketId } });
    }
    context.setStatus(`Ticket ${ticketId} resolved.`);
    return true;
  } catch (error) {
    context.showError(error);
    return false;
  }
}

export function createTicketsScreen(): TuiScreen {
  let root: blessed.Widgets.BoxElement | undefined;
  let list: blessed.Widgets.ListTableElement | undefined;
  let detail: blessed.Widgets.BoxElement | undefined;
  let draft: blessed.Widgets.BoxElement | undefined;
  let context: TuiContext;
  let tickets: any[] = [];
  let filtered: any[] = [];
  let mode: 'organization' | 'partner' = 'organization';
  let searchText = '';
  let selectedIndex = 0;
  let detailText = '';
  let draftText = '';
  let lastResolveTapAt = 0;
  let detailRequestToken = 0;
  let selectionSync: SelectionSyncState = {
    syncing: false,
    name: 'tickets-table'
  };
  const paneConfig = SCREEN_PANE_CONFIG.tickets;
  let activePane: TuiPaneId = paneConfig.defaultPane;
  let isMounted = false;
  let renderErrorMessage = '';
  let renderErrorCount = 0;
  let renderErrorWindowStart = 0;
  let renderFrozen = false;
  const detailCacheByTicket = new Map<string, string>();

  const focusPane = () => {
    if (activePane === 'tickets-table') {
      list?.focus();
      return;
    }
    if (activePane === 'detail-box') {
      detail?.focus();
      return;
    }
    draft?.focus();
  };

  const selectedTicket = () => filtered[selectedIndex];

  const renderRows = () => {
    if (!isMounted) {
      return;
    }
    context.debugLog?.('screen.render.start', {
      screen: 'tickets',
      frozen: renderFrozen
    });
    filtered = searchText
      ? tickets.filter((ticket) => safeSearchText(ticket).includes(searchText.toLowerCase()))
      : tickets;
    selectedIndex = clampIndex(selectedIndex, filtered.length);

    try {
      if (renderFrozen) {
        setListTableData(list, [
          ['ID', 'Status', 'Priority', 'Subject'],
          ...filtered.map((ticket, index) => [
            String(ticket?.id ?? ticket?._id ?? `row-${index + 1}`),
            String(ticket?.status ?? ticket?.state ?? 'unknown'),
            String(ticket?.priority ?? 'n/a'),
            String(ticket?.subject ?? ticket?.title ?? 'n/a')
          ])
        ], selectionSync);
        detail?.setContent('Render fallback mode enabled for ticket details.');
        draft?.setContent('Draft panel preserved. Refresh (r) after narrowing payload/filter.');
      } else {
        const panels = sceneFromTicketsState({
          mode,
          searchText,
          selectedIndex,
          tickets: filtered,
          detailText,
          draftText
        });

        const tablePanel = panels.find((panel) => panel.id === 'tickets-table');
        const detailPanel = panels.find((panel) => panel.id === 'tickets-detail');
        const draftPanel = panels.find((panel) => panel.id === 'tickets-draft');

        setListTableData(list, [
          (tablePanel?.table?.columns ?? ['ID', 'Status', 'Priority', 'Subject']) as [string, string, string, string],
          ...((tablePanel?.table?.rows ?? []) as Array<[string, string, string, string]>)
        ], selectionSync);
        detail?.setContent((detailPanel?.text?.lines ?? ['No tickets.']).join('\n'));
        draft?.setContent((draftPanel?.text?.lines ?? ['Press m to draft ticket response.']).join('\n'));
      }
      renderErrorMessage = '';
      renderErrorCount = 0;
      renderErrorWindowStart = 0;
      context.debugLog?.('screen.render.complete', {
        screen: 'tickets',
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
        screen: 'tickets',
        message,
        count: renderErrorCount,
        frozen: renderFrozen
      });
      context.debugLog?.('screen.render.fallback.applied', {
        screen: 'tickets'
      });
      setListTableData(list, [
        ['ID', 'Status', 'Priority', 'Subject'],
        ...filtered.map((ticket, index) => [
          String(ticket?.id ?? ticket?._id ?? `row-${index + 1}`),
          String(ticket?.status ?? ticket?.state ?? 'unknown'),
          String(ticket?.priority ?? 'n/a'),
          String(ticket?.subject ?? ticket?.title ?? 'n/a')
        ])
      ], selectionSync);
      detail?.setContent(`Unable to render ticket detail safely.\nReason: ${message}`);
      draft?.setContent('Press m to draft ticket response.');
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

    const ticketId = String(ticket?.id ?? ticket?._id ?? '');
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
        const full = mode === 'organization'
          ? await context.client.organization.getTicket({ tenantId, path: { ticket_id: ticketId } })
          : await context.client.partner.getTicket({ tenantId, path: { ticket_id: ticketId } });
        if (!isMounted || requestToken !== detailRequestToken || selectedIndex !== index) {
          return;
        }
        detailText = safePreviewLines(full).lines.join('\n');
        detailCacheByTicket.set(ticketId, detailText);
        renderRows();
        context.screen.render();
      } catch {
        if (!isMounted || requestToken !== detailRequestToken || selectedIndex !== index) {
          return;
        }
        const cached = detailCacheByTicket.get(ticketId);
        detailText = cached
          ? `${cached}\n\n[warning] Unable to refresh full ticket details; showing last successful preview.`
          : `${fallbackPreview}\n\n[warning] Unable to refresh full ticket details.`;
        renderRows();
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
        height: '55%',
        border: 'line',
        label: ' Ticket Detail ',
        scrollable: true,
        alwaysScroll: true,
        keys: false,
        mouse: true,
        vi: true,
        content: 'Select a ticket.'
      });

      draft = blessed.box({
        parent: root,
        top: '55%',
        left: '50%',
        width: '50%',
        height: '45%',
        border: 'line',
        label: ' Draft Tool ',
        tags: true,
        scrollable: true,
        alwaysScroll: true,
        keys: false,
        mouse: true,
        vi: true,
        content: 'Press m to draft ticket response.'
      });
      context.debugLog?.('nav.list.nativeKeysDisabled', {
        screen: 'tickets',
        widgets: ['tickets-table', 'detail-box', 'draft-box']
      });

      list.on('select item', (_item, index) => {
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
      context.debugLog?.('screen.data.fetch.start', {
        screen: 'tickets',
        tenantId
      });
      const loaded = await loadTicketsData(context.client, tenantId);
      if (!isMounted) {
        return;
      }

      mode = loaded.data.mode;
      tickets = loaded.data.tickets;
      selectedIndex = 0;
      detailText = '';
      detailRequestToken += 1;
      detailCacheByTicket.clear();
      context.debugLog?.('screen.data.fetch.complete', {
        screen: 'tickets',
        tenantId,
        count: tickets.length,
        mode,
        connectionState: loaded.connectionState,
        retry: loaded.retry,
        payload: payloadSummary(tickets)
      });
      if (loaded.error) {
        context.setStatus(`Tickets ${loaded.connectionState}: ${loaded.error.message}`);
        context.debugLog?.('screen.data.fetch.error', {
          screen: 'tickets',
          message: loaded.error.message,
          state: loaded.connectionState
        });
      }
      renderRows();
      if (filtered.length) {
        queueTicketDetailFetch(0);
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
      } else {
        scrollBox(draft, delta);
      }
      context.screen.render();
      return 'handled';
    },
    async handleKey(ch, key) {
      const resolveSelectedTicket = async () => {
        const ticket = selectedTicket();
        if (!ticket) {
          context.setStatus('No ticket selected.');
          return true;
        }

        const resolved = await resolveTicketWithGuard({
          ticket,
          mode,
          context
        });
        if (!isMounted) {
          return true;
        }
        if (resolved) {
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
          selectedIndex = 0;
          renderRows();
          context.screen.render();
        }
        return true;
      }

      if (ch === 'm') {
        const ticket = selectedTicket();
        if (!ticket) {
          context.setStatus('No ticket selected.');
          return true;
        }

        context.setStatus('Drafting ticket response...');
        try {
          const drafted = await context.runTicketDraft({ ticket, thread: ticket?.messages ?? ticket?.thread });
          if (!isMounted) {
            return true;
          }
          draftText = [
            `Summary: ${drafted.summary}`,
            'Unresolved asks:',
            ...drafted.unresolvedAsks.map((item) => `- ${item}`),
            '',
            ...drafted.draftOptions.map((option) => `${option.tone}: ${option.draft}`)
          ].join('\n');
          renderRows();
          context.setStatus('Ticket draft generated.');
          context.screen.render();
        } catch (error) {
          context.showError(error);
        }

        return true;
      }

      if (ch === 'R') {
        return resolveSelectedTicket();
      }

      if (ch === 'r') {
        const now = Date.now();
        const tappedTwiceQuickly = now - lastResolveTapAt <= 650;
        lastResolveTapAt = now;
        if (tappedTwiceQuickly) {
          return resolveSelectedTicket();
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
