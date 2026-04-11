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
      detail: 'Provider auto-detection requires connectivity.',
      suggestedCommands: ['Use --provider xyte-org', 'Use --provider xyte-partner']
    });
  }

  let orgError: unknown;
  try {
    await runSlotConnectivityTest({
      provider: PROVIDER_ORG,
      tenantId: args.tenantId,
      key: args.keyValue,
      profileStore: args.profileStore
    });
    return PROVIDER_ORG;
  } catch (error) {
    orgError = error;
  }

  try {
    await runSlotConnectivityTest({
      provider: PROVIDER_PARTNER,
      tenantId: args.tenantId,
      key: args.keyValue,
      profileStore: args.profileStore
    });
    return PROVIDER_PARTNER;
  } catch (partnerError) {
    const orgMsg = orgError instanceof Error ? orgError.message : String(orgError);
    const partnerMsg = partnerError instanceof Error ? partnerError.message : String(partnerError);
    throw new CliUserError({
      summary: 'Provider auto-detection failed for both org and partner.',
      detail: `Org: ${orgMsg}; Partner: ${partnerMsg}`
    });
  }
}
