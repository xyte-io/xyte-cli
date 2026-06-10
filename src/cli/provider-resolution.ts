import { CliUserError } from '../contracts/user-error';
import type { ProfileStore } from '../types/stores';
import { PROVIDER_ORG, PROVIDER_PARTNER, type SecretProvider } from '../types/profile';

import { runSlotConnectivityTest } from '../client/probe';

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
      detail: `Org: ${orgMsg}; Partner: ${partnerMsg}`,
      suggestedCommands: [
        'Verify the API key in the Xyte tenant under Settings -> API Keys',
        '<secret-command> | xyte-cli setup run --non-interactive --tenant <tenant-id> --key-stdin --output json',
        'xyte-cli setup run --non-interactive --tenant <tenant-id> --key-file <path-outside-workspace> --output json'
      ]
    });
  }
}
