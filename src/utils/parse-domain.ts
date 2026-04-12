import { CliUserError } from '../contracts/user-error';
import { SUPPORTED_SECRET_PROVIDERS, isSecretProvider, type SecretProvider } from '../types/profile';
import { INSPECT_PROVIDER_SCOPES, type InspectProviderScope } from '../types/settings-enums';

export function parseProvider(value: string): SecretProvider {
  const normalized = value.trim();
  if (!isSecretProvider(normalized)) {
    throw new CliUserError({ summary: `Invalid provider: ${value}` });
  }
  return normalized;
}

export function parseInspectProviderScope(value: string | undefined): InspectProviderScope {
  const normalized = (value ?? 'auto').trim().toLowerCase();
  if (!(INSPECT_PROVIDER_SCOPES as readonly string[]).includes(normalized)) {
    throw new CliUserError({ summary: `Invalid inspect provider scope: "${value}". Expected organization|partner|auto.` });
  }
  return normalized as InspectProviderScope;
}
