import { CliUserError } from '../contracts/user-error';
import type { ProfileStore } from '../secure/profile-store';
import { PROVIDER_ORG, PROVIDER_PARTNER, type SecretProvider } from '../types/profile';

import { runSlotConnectivityTest } from '../client/probe';
export { runSlotConnectivityTest };

export async function fetchProviderForKey(args: {
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
