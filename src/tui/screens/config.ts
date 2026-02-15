import blessed from 'blessed';

import { createXyteClient } from '../../client/create-client';
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
import { sceneFromConfigState } from '../scene';
import { runKeyCreateWizard, runKeyUpdateWizard } from '../key-wizard';
import type { SecretProvider } from '../../types/profile';
import type { TuiArrowKey, TuiContext, TuiScreen } from '../types';

const PROVIDERS: SecretProvider[] = ['xyte-org', 'xyte-partner', 'xyte-device', 'openai', 'anthropic', 'openai-compatible'];

function providerAt(index: number): SecretProvider {
  return PROVIDERS[clampIndex(index, PROVIDERS.length)];
}

async function runSlotConnectivityProbe(args: {
  context: TuiContext;
  tenantId: string;
  provider: SecretProvider;
  slotId: string;
}): Promise<string> {
  const { context, tenantId, provider, slotId } = args;
  const secret = await context.keychain.getSlotSecret(tenantId, provider, slotId);
  if (!secret) {
    throw new Error(`No secret found for slot ${slotId} (${provider}).`);
  }

  if (provider === 'xyte-org') {
    const client = createXyteClient({
      profileStore: context.profileStore,
      keychain: context.keychain,
      tenantId,
      auth: { organization: secret }
    });
    await client.organization.getOrganizationInfo({ tenantId });
    return 'organization.getOrganizationInfo ok';
  }

  if (provider === 'xyte-partner') {
    const client = createXyteClient({
      profileStore: context.profileStore,
      keychain: context.keychain,
      tenantId,
      auth: { partner: secret }
    });
    await client.partner.getDevices({ tenantId });
    return 'partner.getDevices ok';
  }

  if (provider === 'xyte-device') {
    return 'device-key check: secret present (remote probe skipped)';
  }

  return 'provider key check: secret present (remote probe skipped)';
}

export function createConfigScreen(): TuiScreen {
  let root: blessed.Widgets.BoxElement | undefined;
  let providerTable: blessed.Widgets.ListTableElement | undefined;
  let slotTable: blessed.Widgets.ListTableElement | undefined;
  let actionBox: blessed.Widgets.BoxElement | undefined;
  let context: TuiContext;
  let doctorStatus = 'not run';
  let selectedProviderIndex = 0;
  let selectedSlotIndex = 0;
  let providerSelectionSync: SelectionSyncState = {
    syncing: false,
    name: 'config-providers'
  };
  let slotSelectionSync: SelectionSyncState = {
    syncing: false,
    name: 'config-slots'
  };
  let providerRowsState: Array<{
    provider: SecretProvider;
    slotCount: number;
    activeSlot: string;
    hasSecret: 'yes' | 'no';
    lastValidatedAt?: string;
  }> = [];
  let slotRowsState: Array<{
    provider: SecretProvider;
    slotId: string;
    name: string;
    active: 'yes' | 'no';
    hasSecret: 'yes' | 'no';
    fingerprint: string;
  }> = [];
  const paneConfig = SCREEN_PANE_CONFIG.config;
  let activePane = paneConfig.defaultPane;
  let isMounted = false;

  const focusPane = () => {
    if (activePane === 'providers-table') {
      providerTable?.focus();
      return;
    }
    if (activePane === 'slots-table') {
      slotTable?.focus();
      return;
    }
    actionBox?.focus();
  };

  const render = async () => {
    if (!isMounted) {
      return;
    }

    const activeTenantId = await context.getActiveTenantId();
    const allSlots = activeTenantId ? await context.profileStore.listKeySlots(activeTenantId) : [];

    providerRowsState = [];
    for (const provider of PROVIDERS) {
      const providerSlots = allSlots.filter((slot) => slot.provider === provider);
      const activeSlot = activeTenantId ? await context.profileStore.getActiveKeySlot(activeTenantId, provider) : undefined;
      const hasActiveSecret =
        activeTenantId && activeSlot
          ? Boolean(await context.keychain.getSlotSecret(activeTenantId, provider, activeSlot.slotId))
          : false;

      providerRowsState.push({
        provider,
        slotCount: providerSlots.length,
        activeSlot: activeSlot?.slotId ?? 'none',
        hasSecret: hasActiveSecret ? 'yes' : 'no',
        lastValidatedAt: activeSlot?.lastValidatedAt
      });
    }

    selectedProviderIndex = clampIndex(selectedProviderIndex, providerRowsState.length);
    const selectedProvider = providerRowsState[selectedProviderIndex]?.provider ?? 'xyte-org';

    const filteredSlots = allSlots.filter((slot) => slot.provider === selectedProvider);
    const activeForProvider =
      activeTenantId && selectedProvider
        ? await context.profileStore.getActiveKeySlot(activeTenantId, selectedProvider)
        : undefined;

    slotRowsState = await Promise.all(
      filteredSlots.map(async (slot) => ({
        provider: slot.provider,
        slotId: slot.slotId,
        name: slot.name,
        active: activeForProvider?.slotId === slot.slotId ? 'yes' : 'no',
        hasSecret:
          activeTenantId && (await context.keychain.getSlotSecret(activeTenantId, slot.provider, slot.slotId)) ? 'yes' : 'no',
        fingerprint: slot.fingerprint
      }))
    );
    selectedSlotIndex = clampIndex(selectedSlotIndex, slotRowsState.length);

    const panels = sceneFromConfigState({
      tenantId: activeTenantId,
      providerRows: providerRowsState,
      selectedProvider,
      slotRows: slotRowsState,
      selectedSlot: slotRowsState[selectedSlotIndex],
      doctorStatus
    });

    const providerPanel = panels.find((panel) => panel.id === 'config-providers');
    const slotPanel = panels.find((panel) => panel.id === 'config-slots');
    const actionPanel = panels.find((panel) => panel.id === 'config-actions');

    setListTableData(
      providerTable,
      [
        (providerPanel?.table?.columns ?? ['Provider', 'Slots', 'Active Slot', 'Has Secret', 'Last Validated']) as [
          string,
          string,
          string,
          string,
          string
        ],
        ...((providerPanel?.table?.rows ?? []) as Array<[string, string, string, string, string]>)
      ],
      providerSelectionSync
    );
    syncListSelection(providerTable, selectedProviderIndex, providerSelectionSync);

    setListTableData(
      slotTable,
      [
        (slotPanel?.table?.columns ?? ['Provider', 'Slot', 'Active', 'Secret']) as [string, string, string, string],
        ...((slotPanel?.table?.rows ?? []) as Array<[string, string, string, string]>)
      ],
      slotSelectionSync
    );
    syncListSelection(slotTable, selectedSlotIndex, slotSelectionSync);

    actionBox?.setContent((actionPanel?.text?.lines ?? []).join('\n'));
    focusPane();
    context.screen.render();
  };

  return {
    id: 'config',
    title: 'Config',
    mount(parent, ctx) {
      context = ctx;
      providerSelectionSync = {
        syncing: false,
        name: 'config-providers',
        onLog: (event, data) => context.debugLog?.(event, data)
      };
      slotSelectionSync = {
        syncing: false,
        name: 'config-slots',
        onLog: (event, data) => context.debugLog?.(event, data)
      };
      isMounted = true;

      root = blessed.box({
        parent,
        width: '100%-2',
        height: '100%-2'
      });

      providerTable = blessed.listtable({
        parent: root,
        top: 0,
        left: 0,
        width: '45%',
        height: '65%',
        border: 'line',
        label: ' Provider Health ',
        keys: false,
        mouse: true,
        style: {
          header: { bold: true, fg: 'black', bg: 'white' },
          cell: { selected: { bg: 'blue' } }
        },
        data: [['Provider', 'Slots', 'Active Slot', 'Has Secret', 'Last Validated']]
      });

      slotTable = blessed.listtable({
        parent: root,
        top: 0,
        left: '45%',
        width: '55%',
        height: '65%',
        border: 'line',
        label: ' Provider Slots ',
        keys: false,
        mouse: true,
        style: {
          header: { bold: true, fg: 'black', bg: 'white' },
          cell: { selected: { bg: 'blue' } }
        },
        data: [['Provider', 'Slot', 'Active', 'Secret']]
      });

      actionBox = blessed.box({
        parent: root,
        top: '65%',
        left: 0,
        width: '100%',
        height: '35%',
        border: 'line',
        label: ' Actions ',
        scrollable: true,
        alwaysScroll: true,
        keys: false,
        mouse: true,
        vi: true
      });

      context.debugLog?.('nav.list.nativeKeysDisabled', {
        screen: 'config',
        widgets: ['providers-table', 'slots-table', 'actions-box']
      });
    },
    unmount() {
      isMounted = false;
      root?.destroy();
      root = undefined;
    },
    async refresh() {
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
        const beforeIndex = selectedProviderIndex;
        selectedProviderIndex = moveTableSelection({
          table: providerTable,
          index: selectedProviderIndex,
          delta,
          totalRows: providerRowsState.length,
          selectionSync: providerSelectionSync
        });
        selectedSlotIndex = 0;
        context.debugLog?.('nav.arrow.updown', {
          screen: 'config',
          pane: activePane,
          beforeIndex,
          afterIndex: selectedProviderIndex,
          delta
        });
        await render();
        return 'handled';
      }

      if (activePane === 'slots-table') {
        const beforeIndex = selectedSlotIndex;
        selectedSlotIndex = moveTableSelection({
          table: slotTable,
          index: selectedSlotIndex,
          delta,
          totalRows: slotRowsState.length,
          selectionSync: slotSelectionSync
        });
        context.debugLog?.('nav.arrow.updown', {
          screen: 'config',
          pane: activePane,
          beforeIndex,
          afterIndex: selectedSlotIndex,
          delta
        });
        await render();
        return 'handled';
      }

      scrollBox(actionBox, delta);
      context.screen.render();
      return 'handled';
    },
    async handleKey(ch) {
      try {
        if (ch === 'r') {
          await this.refresh();
          context.setStatus('Config refreshed.');
          return true;
        }

        if (ch === 'c') {
          const readiness = await context.refreshReadiness(true);
          doctorStatus = `${readiness.connectionState}: ${readiness.connectivity.message}`;
          await this.refresh();
          context.setStatus('Connectivity doctor executed.');
          return true;
        }

        const tenantId = await context.getActiveTenantId();
        if (!tenantId && ['a', 'n', 'u', 'e', 't', 'x'].includes(ch ?? '')) {
          context.setStatus('No active tenant. Use setup screen first.');
          return true;
        }

        const selectedProvider = providerAt(selectedProviderIndex);
        const selectedSlot = slotRowsState[clampIndex(selectedSlotIndex, slotRowsState.length)];

        if (ch === 'a' && tenantId) {
          const result = await runKeyCreateWizard({
            context,
            tenantId,
            defaultProvider: selectedProvider,
            defaultSlotName: 'primary',
            setActiveDefault: true
          });
          await this.refresh();
          context.setStatus(result.message);
          return true;
        }

        if (ch === 'n' && tenantId) {
          if (!selectedSlot) {
            context.setStatus('No slot selected to rename.');
            return true;
          }
          const nextName = (await context.prompt('New slot name:', selectedSlot.name))?.trim();
          if (!nextName) {
            return true;
          }
          await context.profileStore.updateKeySlot(tenantId, selectedProvider, selectedSlot.slotId, { name: nextName });
          await this.refresh();
          context.setStatus(`Renamed slot ${selectedSlot.slotId}.`);
          return true;
        }

        if (ch === 'u' && tenantId) {
          if (!selectedSlot) {
            context.setStatus('No slot selected to activate.');
            return true;
          }
          await context.profileStore.setActiveKeySlot(tenantId, selectedProvider, selectedSlot.slotId);
          await this.refresh();
          context.setStatus(`Active slot changed for ${selectedProvider}.`);
          return true;
        }

        if (ch === 'e' && tenantId) {
          if (!selectedSlot) {
            context.setStatus('No slot selected to rotate.');
            return true;
          }
          const result = await runKeyUpdateWizard({
            context,
            tenantId,
            provider: selectedProvider,
            slotRef: selectedSlot.slotId,
            promptEditSelected: true,
            setActiveDefault: selectedSlot.active === 'yes'
          });
          await this.refresh();
          context.setStatus(result.message);
          return true;
        }

        if (ch === 't' && tenantId) {
          if (!selectedSlot) {
            context.setStatus('No slot selected to test.');
            return true;
          }
          const probe = await runSlotConnectivityProbe({
            context,
            tenantId,
            provider: selectedProvider,
            slotId: selectedSlot.slotId
          });
          await context.profileStore.updateKeySlot(tenantId, selectedProvider, selectedSlot.slotId, {
            lastValidatedAt: new Date().toISOString()
          });
          await this.refresh();
          context.setStatus(`Connectivity probe ok: ${probe}`);
          return true;
        }

        if (ch === 'x' && tenantId) {
          if (!selectedSlot) {
            context.setStatus('No slot selected to remove.');
            return true;
          }
          const confirmed = await context.confirmWrite(`Remove slot ${selectedSlot.slotId}`, 'remove');
          if (!confirmed) {
            context.setStatus('Remove action canceled.');
            return true;
          }
          await context.keychain.clearSlotSecret(tenantId, selectedProvider, selectedSlot.slotId);
          await context.profileStore.removeKeySlot(tenantId, selectedProvider, selectedSlot.slotId);
          await this.refresh();
          context.setStatus(`Removed slot ${selectedSlot.slotId}.`);
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
