import { createXyteClient } from '../client/create-client';
import { CliUserError } from '../contracts/user-error';
import type { ProfileStore } from '../secure/profile-store';
import { PROVIDER_ORG, PROVIDER_PARTNER, type SecretProvider } from '../types/profile';

export async function runSlotConnectivityTest(args: {
  provider: SecretProvider;
  tenantId: string;
  key: string;
  profileStore: ProfileStore;
}) {
  if (args.provider === PROVIDER_ORG) {
    const client = createXyteClient({
      profileStore: args.profileStore,
      tenantId: args.tenantId,
      auth: { organization: args.key }
    });
    await client.organization.getOrganizationInfo({ tenantId: args.tenantId });
    return {
      strategy: 'organization.getOrganizationInfo',
      ok: true
    };
  }

  if (args.provider === PROVIDER_PARTNER) {
    const client = createXyteClient({
      profileStore: args.profileStore,
      tenantId: args.tenantId,
      auth: { partner: args.key }
    });
    await client.partner.getDevices({ tenantId: args.tenantId });
    return {
      strategy: 'partner.getDevices',
      ok: true
    };
  }

  const _exhaustive: never = args.provider;
  throw new Error(`Unhandled provider: ${_exhaustive}`);
}

export async function resolveProviderForKey(args: {
  profileStore: ProfileStore;
  tenantId: string;
  keyValue: string;
  provider?: SecretProvider;
  allowProbe: boolean;
}): Promise<SecretProvider> {
  if (args.provider) {
    return args.provider;
  }

  if (!args.allowProbe) {
    throw new CliUserError({
      summary: 'Missing provider.',
      cause: 'Provider auto-detection requires connectivity.',
      suggestedCommands: ['Use --provider xyte-org', 'Use --provider xyte-partner']
    });
  }

  try {
    await runSlotConnectivityTest({
      provider: PROVIDER_ORG,
      tenantId: args.tenantId,
      key: args.keyValue,
      profileStore: args.profileStore
    });
    return PROVIDER_ORG;
  } catch {
    await runSlotConnectivityTest({
      provider: PROVIDER_PARTNER,
      tenantId: args.tenantId,
      key: args.keyValue,
      profileStore: args.profileStore
    });
    return PROVIDER_PARTNER;
  }
}
