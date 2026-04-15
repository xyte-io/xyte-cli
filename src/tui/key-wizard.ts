import { CliUserError } from '../contracts/user-error';
import { makeKeyFingerprint, matchesSlotRef } from '../secure/key-slots';
import type { ApiKeySlotMeta, SecretProvider } from '../types/profile';
import { PROVIDER_ORG, SUPPORTED_SECRET_PROVIDERS } from '../types/profile';
import type { TuiContext } from './types';

const PROVIDERS: SecretProvider[] = [...SUPPORTED_SECRET_PROVIDERS];

interface WizardContext extends Pick<
  TuiContext,
  'prompt' | 'promptSecret' | 'confirmWrite' | 'setStatus' | 'profileStore' | 'secretStore'
> {}

interface KeyWizardResult {
  canceled: boolean;
  provider?: SecretProvider;
  slotId?: string;
  message: string;
}

interface RunKeyCreateWizardArgs {
  context: WizardContext;
  tenantId: string;
  defaultProvider?: SecretProvider;
  defaultSlotName?: string;
  setActiveDefault?: boolean;
}

interface RunKeyUpdateWizardArgs {
  context: WizardContext;
  tenantId: string;
  provider: SecretProvider;
  slotRef: string;
  promptEditSelected?: boolean;
  setActiveDefault?: boolean;
}

function canceledResult(message = 'Canceled setup wizard.'): KeyWizardResult {
  return {
    canceled: true,
    message
  };
}

function parseProviderInput(input: string): SecretProvider | undefined {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  const asNumber = Number.parseInt(trimmed, 10);
  if (Number.isFinite(asNumber)) {
    const provider = PROVIDERS[asNumber - 1];
    return provider;
  }

  return PROVIDERS.find((provider) => provider === trimmed);
}

async function promptProvider(
  context: WizardContext,
  defaultProvider: SecretProvider
): Promise<SecretProvider | undefined> {
  while (true) {
    const menu = [
      'Provider:',
      ...PROVIDERS.map((provider, index) => `${index + 1}. ${provider}`),
      '',
      'Type a number or provider id.'
    ].join('\n');
    const input = await context.prompt(menu, defaultProvider);
    if (input === undefined || !input.trim()) {
      return undefined;
    }
    const provider = parseProviderInput(input);
    if (provider) {
      return provider;
    }
    context.setStatus(`Unknown provider "${input}".`);
  }
}

async function promptNonEmpty(context: WizardContext, message: string, initial: string): Promise<string | undefined> {
  const input = await context.prompt(message, initial);
  if (input === undefined || !input.trim()) {
    return undefined;
  }
  return input.trim();
}

async function promptSecretNonEmpty(context: WizardContext, message: string): Promise<string | undefined> {
  const input = await context.promptSecret(message, '');
  if (input === undefined || !input.trim()) {
    return undefined;
  }
  return input.trim();
}

async function promptYesNo(
  context: WizardContext,
  message: string,
  defaultValue: boolean
): Promise<boolean | undefined> {
  while (true) {
    const input = await context.prompt(`${message} (y/n)`, defaultValue ? 'y' : 'n');
    if (input === undefined || !input.trim()) {
      return undefined;
    }
    const normalized = input.trim().toLowerCase();
    if (['y', 'yes'].includes(normalized)) {
      return true;
    }
    if (['n', 'no'].includes(normalized)) {
      return false;
    }
    context.setStatus(`Invalid response "${input}". Use y or n.`);
  }
}

function labelForSlot(slot: ApiKeySlotMeta): string {
  return `${slot.name} (${slot.slotId})`;
}

export async function runKeyCreateWizard(args: RunKeyCreateWizardArgs): Promise<KeyWizardResult> {
  const { context, tenantId } = args;
  const existingTenant = await context.profileStore.getTenant(tenantId);
  const provider = await promptProvider(context, args.defaultProvider ?? PROVIDER_ORG);
  if (!provider) {
    return canceledResult();
  }

  const slotName = await promptNonEmpty(context, 'Slot name:', args.defaultSlotName ?? 'primary');
  if (!slotName) {
    return canceledResult();
  }

  const keyValue = await promptSecretNonEmpty(context, 'API key value:');
  if (!keyValue) {
    return canceledResult();
  }

  const setActive = await promptYesNo(context, 'Set this slot as active now?', args.setActiveDefault ?? true);
  if (setActive === undefined) {
    return canceledResult();
  }

  const fingerprint = makeKeyFingerprint(keyValue);
  const confirmed = await context.confirmWrite(
    `Save slot "${slotName}" for ${provider} [${fingerprint}]${setActive ? ' and set active' : ''}`,
    'save'
  );
  if (!confirmed) {
    return canceledResult();
  }

  const slot = await context.profileStore.addKeySlot(tenantId, provider, {
    name: slotName,
    fingerprint
  });
  await context.secretStore.setSlotSecret(tenantId, provider, slot.slotId, keyValue);
  if (setActive) {
    await context.profileStore.setActiveKeySlot(tenantId, provider, slot.slotId);
  } else if (!existingTenant?.apiProvider) {
    await context.profileStore.upsertTenant({ id: tenantId, apiProvider: provider });
  }

  const message = `Saved ${provider} slot ${labelForSlot(slot)}.`;
  context.setStatus(message);
  return {
    canceled: false,
    provider,
    slotId: slot.slotId,
    message
  };
}

export async function runKeyUpdateWizard(args: RunKeyUpdateWizardArgs): Promise<KeyWizardResult> {
  const { context, tenantId, provider, slotRef } = args;

  if (args.promptEditSelected) {
    const editSelected = await promptYesNo(context, `Edit selected slot "${slotRef}" for ${provider}?`, true);
    if (editSelected === undefined || !editSelected) {
      return canceledResult();
    }
  }

  const slots = await context.profileStore.listKeySlots(tenantId, provider);
  const slot = slots.find((item) => matchesSlotRef(item, slotRef));
  if (!slot) {
    throw new CliUserError({ summary: `Unknown slot "${slotRef}" for ${provider}.` });
  }

  const slotName = await promptNonEmpty(context, 'Slot name:', slot.name);
  if (!slotName) {
    return canceledResult();
  }

  const keyValue = await promptSecretNonEmpty(context, 'New key value:');
  if (!keyValue) {
    return canceledResult();
  }

  const setActive = await promptYesNo(context, 'Set this slot as active now?', args.setActiveDefault ?? true);
  if (setActive === undefined) {
    return canceledResult();
  }

  const fingerprint = makeKeyFingerprint(keyValue);
  const confirmed = await context.confirmWrite(
    `Update slot "${slotName}" (${slot.slotId}) for ${provider} [${fingerprint}]${setActive ? ' and set active' : ''}`,
    'save'
  );
  if (!confirmed) {
    return canceledResult();
  }

  await context.secretStore.setSlotSecret(tenantId, provider, slot.slotId, keyValue);
  const updated = await context.profileStore.updateKeySlot(tenantId, provider, slot.slotId, {
    name: slotName,
    fingerprint
  });
  if (setActive) {
    await context.profileStore.setActiveKeySlot(tenantId, provider, updated.slotId);
  }

  const message = `Updated ${provider} slot ${labelForSlot(updated)}.`;
  context.setStatus(message);
  return {
    canceled: false,
    provider,
    slotId: updated.slotId,
    message
  };
}
