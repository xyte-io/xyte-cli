import { describe, expect, it } from 'vitest';

import { runHeadlessRenderer, renderFrameAsText } from '../../src/tui/headless-renderer';
import type { HeadlessFrame } from '../../src/tui/scene';
import { MemoryKeychain } from '../../src/secure/keychain';
import { SCREEN_PANE_CONFIG } from '../../src/tui/panes';
import type { TuiScreenId } from '../../src/tui/types';
import { MemoryProfileStore } from '../support/memory-profile-store';
import { HEADLESS_FRAME_SCHEMA_VERSION } from '../../src/contracts/versions';

function parseRuntimeFrame(chunks: string[]): (HeadlessFrame & { meta?: Record<string, unknown> }) | undefined {
  const parsed = chunks
    .join('')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as HeadlessFrame & { meta?: Record<string, unknown> });
  return parsed.find((frame) => !((frame.meta as Record<string, unknown> | undefined)?.startup));
}

async function makeReadyProfile() {
  const profileStore = new MemoryProfileStore();
  const keychain = new MemoryKeychain();
  await profileStore.upsertTenant({ id: 'acme' });
  await profileStore.setActiveTenant('acme');
  const slot = await profileStore.addKeySlot('acme', {
    provider: 'xyte-org',
    name: 'primary',
    fingerprint: 'sha256:test'
  });
  await keychain.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key');
  return { profileStore, keychain };
}

describe('headless renderer', () => {
  it('emits JSON frames with required schema', async () => {
    const { profileStore, keychain } = await makeReadyProfile();

    const chunks: string[] = [];
    const output = {
      write: (text: string) => {
        chunks.push(text);
        return true;
      }
    };

    const client: any = {
      organization: {
        getDevices: async () => [{ id: 'dev-1', name: 'Device One', status: 'online' }],
        getIncidents: async () => [{ id: 'inc-1', severity: 'high', status: 'open' }],
        getTickets: async () => [{ id: 'tic-1', subject: 'Need help', status: 'open' }],
        getSpaces: async () => [{ id: 'sp-1', name: 'Room A', space_type: 'room' }],
        getSpace: async () => ({ id: 'sp-1', name: 'Room A' })
      },
      partner: {
        getDevices: async () => [],
        getTickets: async () => []
      }
    };

    await runHeadlessRenderer({
      client,
      profileStore,
      keychain,
      screen: 'spaces',
      format: 'json',
      motionEnabled: false,
      follow: false,
      output
    });

    const runtimeFrame = parseRuntimeFrame(chunks);
    expect(runtimeFrame).toBeDefined();
    expect(runtimeFrame?.schemaVersion).toBe(HEADLESS_FRAME_SCHEMA_VERSION);
    expect(typeof runtimeFrame?.sessionId).toBe('string');
    expect(typeof runtimeFrame?.sequence).toBe('number');
    expect(runtimeFrame?.screen).toBe('spaces');
    expect(runtimeFrame?.motionEnabled).toBe(false);
    expect(Array.isArray(runtimeFrame?.panels)).toBe(true);
    expect(runtimeFrame?.panels.length).toBeGreaterThan(0);
    expect((runtimeFrame?.meta as any)?.inputState).toBe('idle');
    expect((runtimeFrame?.meta as any)?.queueDepth).toBe(0);
    expect((runtimeFrame?.meta as any)?.droppedEvents).toBe(0);
    expect((runtimeFrame?.meta as any)?.transitionState).toBe('idle');
    expect((runtimeFrame?.meta as any)?.navigationMode).toBe('pane-focus');
    expect((runtimeFrame?.meta as any)?.refreshState).toBeDefined();
    expect((runtimeFrame?.meta as any)?.tabId).toBe('spaces');
    expect((runtimeFrame?.meta as any)?.tabOrder).toEqual(['setup', 'config', 'dashboard', 'spaces', 'devices', 'incidents', 'tickets', 'copilot']);
    expect((runtimeFrame?.meta as any)?.tabNavBoundary).toBeNull();
    expect((runtimeFrame?.meta as any)?.renderSafety).toBeDefined();
    expect((runtimeFrame?.meta as any)?.tableFormat).toBe('compact-v1');
    expect((runtimeFrame?.meta as any)?.contract?.frameVersion).toBe(HEADLESS_FRAME_SCHEMA_VERSION);
  });

  it('renders text frames with logo and panel sections', () => {
    const text = renderFrameAsText({
      schemaVersion: HEADLESS_FRAME_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      sessionId: 'sess-1',
      sequence: 0,
      mode: 'headless',
      screen: 'dashboard',
      title: 'Dashboard',
      status: 'ok',
      tenantId: 'acme',
      motionEnabled: false,
      motionPhase: 0,
      logo: 'XYTE',
      panels: [
        {
          id: 'stats',
          title: 'Stats',
          kind: 'stats',
          stats: [
            { label: 'Devices', value: 10 },
            { label: 'Incidents', value: 2 }
          ]
        }
      ]
    });

    expect(text).toContain('XYTE');
    expect(text).toContain('Screen: dashboard');
    expect(text).toContain('== Stats ==');
    expect(text).toContain('Devices: 10');
  });

  it('treats EPIPE as graceful termination', async () => {
    const profileStore = new MemoryProfileStore();
    const keychain = new MemoryKeychain();
    const output = {
      write: (_text: string) => {
        const error = new Error('pipe closed') as NodeJS.ErrnoException;
        error.code = 'EPIPE';
        throw error;
      }
    };

    const client: any = {
      organization: {
        getDevices: async () => [],
        getIncidents: async () => [],
        getTickets: async () => [],
        getSpaces: async () => [],
        getSpace: async () => ({})
      },
      partner: {
        getDevices: async () => [],
        getTickets: async () => []
      }
    };

    await expect(
      runHeadlessRenderer({
        client,
        profileStore,
        keychain,
        screen: 'copilot',
        format: 'json',
        motionEnabled: false,
        follow: false,
        output
      })
    ).resolves.toBeUndefined();
  });

  it('redirects blocked operational screen to setup when readiness is not complete', async () => {
    const profileStore = new MemoryProfileStore();
    const keychain = new MemoryKeychain();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const chunks: string[] = [];
    const output = {
      write: (text: string) => {
        chunks.push(text);
        return true;
      }
    };

    const client: any = {
      organization: {
        getOrganizationInfo: async () => ({ ok: true }),
        getDevices: async () => [],
        getIncidents: async () => [],
        getTickets: async () => [],
        getSpaces: async () => [],
        getSpace: async () => ({})
      },
      partner: {
        getDevices: async () => [],
        getTickets: async () => []
      }
    };

    await runHeadlessRenderer({
      client,
      profileStore,
      keychain,
      screen: 'dashboard',
      format: 'json',
      motionEnabled: false,
      follow: false,
      output
    });

    const runtimeFrame = parseRuntimeFrame(chunks);

    expect(runtimeFrame?.screen).toBe('setup');
    expect((runtimeFrame?.meta as any)?.redirectedFrom).toBe('dashboard');
  });

  it('emits pane metadata for every screen in one-shot mode', async () => {
    const { profileStore, keychain } = await makeReadyProfile();
    const screens: TuiScreenId[] = ['setup', 'config', 'dashboard', 'spaces', 'devices', 'incidents', 'tickets', 'copilot'];

    const client: any = {
      organization: {
        getOrganizationInfo: async () => ({ ok: true }),
        getDevices: async () => [{ id: 'dev-1', name: 'Device One', status: 'online', space_id: 'sp-1' }],
        getIncidents: async () => [{ id: 'inc-1', severity: 'high', status: 'open', device_id: 'dev-1' }],
        getTickets: async () => [{ id: 'tic-1', subject: 'Need help', status: 'open' }],
        getSpaces: async () => [{ id: 'sp-1', name: 'Room A', space_type: 'room' }],
        getSpace: async () => ({ id: 'sp-1', name: 'Room A' })
      },
      partner: {
        getDevices: async () => [],
        getTickets: async () => []
      }
    };

    for (const screen of screens) {
      const chunks: string[] = [];
      const output = {
        write: (text: string) => {
          chunks.push(text);
          return true;
        }
      };

      await runHeadlessRenderer({
        client,
        profileStore,
        keychain,
        screen,
        format: 'json',
        motionEnabled: false,
        follow: false,
        output
      });

      const runtimeFrame = parseRuntimeFrame(chunks);
      expect(runtimeFrame).toBeDefined();
      expect(runtimeFrame?.schemaVersion).toBe(HEADLESS_FRAME_SCHEMA_VERSION);
      expect(runtimeFrame?.screen).toBe(screen);
      expect((runtimeFrame?.meta as any)?.navigationMode).toBe('pane-focus');
      expect((runtimeFrame?.meta as any)?.activePane).toBe(SCREEN_PANE_CONFIG[screen].defaultPane);
      expect((runtimeFrame?.meta as any)?.availablePanes).toEqual(SCREEN_PANE_CONFIG[screen].panes);
      expect((runtimeFrame?.meta as any)?.tabId).toBe(screen);
      expect((runtimeFrame?.meta as any)?.tabOrder).toEqual(['setup', 'config', 'dashboard', 'spaces', 'devices', 'incidents', 'tickets', 'copilot']);
      expect((runtimeFrame?.meta as any)?.renderSafety).toBeDefined();
      expect((runtimeFrame?.meta as any)?.tableFormat).toBe('compact-v1');
    }
  });
});
