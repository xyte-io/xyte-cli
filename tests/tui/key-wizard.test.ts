import { describe, expect, it, vi } from 'vitest';

import { MemoryKeychain } from '../../src/secure/keychain';
import { runKeyCreateWizard, runKeyUpdateWizard } from '../../src/tui/key-wizard';
import { MemoryProfileStore } from '../support/memory-profile-store';

function makePromptQueue(values: Array<string | undefined>) {
  const queue = [...values];
  return vi.fn(async () => queue.shift());
}

describe('key wizard', () => {
  it('creates a slot through guided flow', async () => {
    const profileStore = new MemoryProfileStore();
    const keychain = new MemoryKeychain();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const prompt = makePromptQueue(['1', 'primary', 'y']);
    const promptSecret = makePromptQueue(['super-secret']);
    const setStatus = vi.fn();
    const confirmWrite = vi.fn(async () => true);

    const result = await runKeyCreateWizard({
      context: {
        prompt,
        promptSecret,
        confirmWrite,
        setStatus,
        profileStore,
        keychain
      },
      tenantId: 'acme',
      defaultProvider: 'xyte-org'
    });

    expect(result.canceled).toBe(false);
    expect(result.provider).toBe('xyte-org');
    const slots = await profileStore.listKeySlots('acme', 'xyte-org');
    expect(slots).toHaveLength(1);
    const secret = await keychain.getSlotSecret('acme', 'xyte-org', slots[0].slotId);
    expect(secret).toBe('super-secret');
    const active = await profileStore.getActiveKeySlot('acme', 'xyte-org');
    expect(active?.slotId).toBe(slots[0].slotId);
  });

  it('re-prompts invalid provider selection and supports cancellation', async () => {
    const profileStore = new MemoryProfileStore();
    const keychain = new MemoryKeychain();
    await profileStore.upsertTenant({ id: 'acme' });

    const prompt = makePromptQueue(['not-a-provider', '2', '']);
    const promptSecret = makePromptQueue([]);
    const setStatus = vi.fn();

    const result = await runKeyCreateWizard({
      context: {
        prompt,
        promptSecret,
        confirmWrite: vi.fn(async () => true),
        setStatus,
        profileStore,
        keychain
      },
      tenantId: 'acme'
    });

    expect(result.canceled).toBe(true);
    expect(setStatus).toHaveBeenCalledWith('Unknown provider "not-a-provider".');
    const slots = await profileStore.listKeySlots('acme');
    expect(slots).toHaveLength(0);
  });

  it('updates selected slot through guided flow', async () => {
    const profileStore = new MemoryProfileStore();
    const keychain = new MemoryKeychain();
    await profileStore.upsertTenant({ id: 'acme' });
    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'primary',
      fingerprint: 'sha256:old'
    });

    const prompt = makePromptQueue(['y', 'primary-prod', 'y']);
    const promptSecret = makePromptQueue(['new-secret']);
    const confirmWrite = vi.fn(async () => true);

    const result = await runKeyUpdateWizard({
      context: {
        prompt,
        promptSecret,
        confirmWrite,
        setStatus: vi.fn(),
        profileStore,
        keychain
      },
      tenantId: 'acme',
      provider: 'xyte-org',
      slotRef: slot.slotId,
      promptEditSelected: true
    });

    expect(result.canceled).toBe(false);
    const updated = await profileStore.getActiveKeySlot('acme', 'xyte-org');
    expect(updated?.name).toBe('primary-prod');
    const secret = await keychain.getSlotSecret('acme', 'xyte-org', slot.slotId);
    expect(secret).toBe('new-secret');
  });
});

