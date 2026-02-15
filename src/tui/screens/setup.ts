import blessed from 'blessed';

import {
  clampIndex,
  movePaneWithBoundary,
  moveTableSelection,
  scrollBox,
  setListTableData,
  syncListSelection,
  type SelectionSyncState
} from '../navigation';
import { SCREEN_PANE_CONFIG } from '../panes';
import type { TuiArrowKey, TuiContext, TuiScreen } from '../types';
import type { SecretProvider } from '../../types/profile';
import { sceneFromSetupState } from '../scene';
import { runKeyCreateWizard } from '../key-wizard';

const PROVIDERS: SecretProvider[] = ['xyte-org', 'xyte-partner', 'xyte-device', 'openai', 'anthropic', 'openai-compatible'];

function parseProvider(value: string): SecretProvider {
  const normalized = value.trim() as SecretProvider;
  if (!PROVIDERS.includes(normalized)) {
    throw new Error(`Invalid provider: ${value}`);
  }
  return normalized;
}

export function createSetupScreen(): TuiScreen {
  let root: blessed.Widgets.BoxElement | undefined;
  let statsBox: blessed.Widgets.BoxElement | undefined;
  let providerTable: blessed.Widgets.ListTableElement | undefined;
  let checklistBox: blessed.Widgets.BoxElement | undefined;
  let context: TuiContext;
  let selectedProviderIndex = 0;
  let providerSelectionSync: SelectionSyncState = {
    syncing: false,
    name: 'setup-providers'
  };
  let providerRowsState: SecretProvider[] = [];
  const paneConfig = SCREEN_PANE_CONFIG.setup;
  let activePane = paneConfig.defaultPane;
  let isMounted = false;

  const focusPane = () => {
    if (activePane === 'providers-table') {
      providerTable?.focus();
      return;
    }
    checklistBox?.focus();
  };

  const render = async () => {
    if (!isMounted) {
      return;
    }
    const readiness = context.getReadiness() ?? (await context.refreshReadiness(true));
    if (!isMounted) {
      return;
    }
    const panels = sceneFromSetupState({
      tenantId: readiness.tenantId,
      readinessState: readiness.state,
      connectionState: readiness.connectionState,
      missingItems: readiness.missingItems,
      recommendedActions: readiness.recommendedActions,
      providerRows: readiness.providers.map((provider) => ({
        provider: provider.provider,
        slotCount: provider.slotCount,
        activeSlot: provider.activeSlotId ?? 'none',
        hasSecret: provider.hasActiveSecret ? 'yes' : 'no'
      }))
    });
    providerRowsState = readiness.providers.map((provider) => provider.provider);

    const overview = panels.find((panel) => panel.id === 'setup-overview');
    const providers = panels.find((panel) => panel.id === 'setup-providers');
    const checklist = panels.find((panel) => panel.id === 'setup-checklist');

    statsBox?.setContent((overview?.stats ?? []).map((stat) => `${stat.label}: ${stat.value}`).join('\n'));
    setListTableData(providerTable, [
      (providers?.table?.columns ?? ['Provider', 'Slots', 'Active Slot', 'Has Secret']) as [string, string, string, string],
      ...((providers?.table?.rows ?? []) as Array<[string, string, string, string]>)
    ], providerSelectionSync);
    selectedProviderIndex = clampIndex(selectedProviderIndex, readiness.providers.length);
    syncListSelection(providerTable, selectedProviderIndex, providerSelectionSync);
    checklistBox?.setContent((checklist?.text?.lines ?? []).join('\n'));
    focusPane();
    context.screen.render();
  };

  return {
    id: 'setup',
    title: 'Setup',
    mount(parent, ctx) {
      context = ctx;
      providerSelectionSync = {
        syncing: false,
        name: 'setup-providers',
        onLog: (event, data) => context.debugLog?.(event, data)
      };
      isMounted = true;
      root = blessed.box({
        parent,
        width: '100%-2',
        height: '100%-2'
      });

      statsBox = blessed.box({
        parent: root,
        top: 0,
        left: 0,
        width: '100%',
        height: 4,
        border: 'line',
        label: ' Readiness '
      });

      providerTable = blessed.listtable({
        parent: root,
        top: 4,
        left: 0,
        width: '100%',
        height: 9,
        border: 'line',
        label: ' Provider Slots ',
        keys: false,
        mouse: true,
        style: {
          header: { bold: true, fg: 'black', bg: 'white' },
          cell: { selected: { bg: 'blue' } }
        },
        data: [['Provider', 'Slots', 'Active Slot', 'Has Secret']]
      });

      checklistBox = blessed.box({
        parent: root,
        top: 13,
        left: 0,
        width: '100%',
        height: '100%-13',
        border: 'line',
        label: ' Checklist ',
        scrollable: true,
        alwaysScroll: true,
        vi: true,
        keys: false,
        mouse: true
      });
      context.debugLog?.('nav.list.nativeKeysDisabled', {
        screen: 'setup',
        widgets: ['providers-table', 'checklist-box']
      });
    },
    unmount() {
      isMounted = false;
      root?.destroy();
      root = undefined;
    },
    async refresh() {
      await context.refreshReadiness(true);
      await render();
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

      if (activePane === 'providers-table') {
        const readiness = context.getReadiness();
        const totalRows = readiness?.providers.length ?? 0;
        const beforeIndex = selectedProviderIndex;
        selectedProviderIndex = moveTableSelection({
          table: providerTable,
          index: selectedProviderIndex,
          delta,
          totalRows,
          selectionSync: providerSelectionSync
        });
        context.debugLog?.('nav.arrow.updown', {
          screen: 'setup',
          pane: activePane,
          beforeIndex,
          afterIndex: selectedProviderIndex,
          delta
        });
        context.screen.render();
        return 'handled';
      }

      scrollBox(checklistBox, delta);
      context.screen.render();
      return 'handled';
    },
    async handleKey(ch) {
      try {
        if (ch === 'r') {
          await this.refresh();
          context.setStatus('Setup refreshed.');
          return true;
        }

        if (ch === 'c') {
          await context.refreshReadiness(true);
          await render();
          context.setStatus('Connectivity probe complete.');
          return true;
        }

        if (ch === 'a') {
          const tenantId = (await context.prompt('Tenant id:', ''))?.trim();
          if (!isMounted) {
            return true;
          }
          if (!tenantId) {
            return true;
          }
          const tenantName = (await context.prompt('Tenant display name:', tenantId))?.trim() || tenantId;
          await context.profileStore.upsertTenant({ id: tenantId, name: tenantName });
          await context.profileStore.setActiveTenant(tenantId);
          await this.refresh();
          context.setStatus(`Tenant ${tenantId} configured and active.`);
          return true;
        }

        if (ch === 'u') {
          const data = await context.profileStore.getData();
          const hint = data.activeTenantId ?? data.tenants[0]?.id ?? '';
          const tenantId = (await context.prompt('Set active tenant id:', hint))?.trim();
          if (!isMounted) {
            return true;
          }
          if (!tenantId) {
            return true;
          }
          await context.profileStore.setActiveTenant(tenantId);
          await this.refresh();
          context.setStatus(`Active tenant set to ${tenantId}.`);
          return true;
        }

        if (ch === 'k') {
          const tenantId = await context.getActiveTenantId();
          if (!tenantId) {
            context.setStatus('Set an active tenant first (a/u).');
            return true;
          }
          const selectedProvider = providerRowsState[clampIndex(selectedProviderIndex, providerRowsState.length)] ?? 'xyte-org';
          const result = await runKeyCreateWizard({
            context,
            tenantId,
            defaultProvider: selectedProvider,
            defaultSlotName: 'primary',
            setActiveDefault: true
          });
          if (!isMounted) {
            return true;
          }
          await this.refresh();
          if (result.canceled) {
            context.setStatus(result.message);
            return true;
          }
          context.setStatus(result.message);
          return true;
        }

        if (ch === 'p') {
          const tenantId = await context.getActiveTenantId();
          if (!tenantId) {
            context.setStatus('Set an active tenant first.');
            return true;
          }
          const providerText = (await context.prompt('Provider:', 'xyte-org'))?.trim();
          if (!isMounted) {
            return true;
          }
          if (!providerText) {
            return true;
          }
          const provider = parseProvider(providerText);
          const slotRef = (await context.prompt('Slot id or name:', ''))?.trim();
          if (!isMounted) {
            return true;
          }
          if (!slotRef) {
            return true;
          }
          await context.profileStore.setActiveKeySlot(tenantId, provider, slotRef);
          await this.refresh();
          context.setStatus(`Active slot updated for ${provider}.`);
          return true;
        }
      } catch (error) {
        context.showError(error);
        return true;
      }

      return false;
    }
  };
}
