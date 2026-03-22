import { getEndpoint, listEndpoints } from './catalog';
import { HttpTransport } from '../http/transport';
import { XyteAuthError, XyteValidationError } from '../http/errors';
import { createOrganizationNamespace } from './namespaces/organization';
import { createPartnerNamespace } from './namespaces/partner';
import { createSecretStore, type SecretStore } from '../secure/secret-store';
import { FileProfileStore, type ProfileStore } from '../secure/profile-store';
import type { PublicEndpointSpec } from '../types/endpoints';
import { PROVIDER_ORG, PROVIDER_PARTNER, type SecretProvider } from '../types/profile';
import type { XyteCallArgs, XyteCallResult, XyteClient, XyteClientOptions } from '../types/client';
import { isRecord } from '../utils/json';

const DEFAULT_HUB_BASE_URL = 'https://hub.xyte.io';
const DEFAULT_ENTRY_BASE_URL = 'https://entry.xyte.io';

function withPathParams(pathTemplate: string, pathParams: PublicEndpointSpec['pathParams'], path: XyteCallArgs['path']): string {
  let compiled = pathTemplate;
  for (const param of pathParams) {
    const value = path?.[param];
    if (value === undefined || value === null) {
      throw new XyteValidationError(`Missing required path parameter: ${param}`);
    }
    compiled = compiled.replaceAll(`:${param}`, encodeURIComponent(String(value)));
  }
  return compiled;
}

function withQueryParams(url: URL, query: XyteCallArgs['query']): URL {
  if (!query) {
    return url;
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

function authProviderFromScope(scope: PublicEndpointSpec['authScope']): SecretProvider | undefined {
  if (scope === 'organization') {
    return PROVIDER_ORG;
  }
  if (scope === 'partner') {
    return PROVIDER_PARTNER;
  }
  return undefined;
}

function directAuthValue(options: XyteClientOptions, scope: PublicEndpointSpec['authScope']): string | undefined {
  if (scope === 'organization') {
    return options.auth?.organization;
  }
  if (scope === 'partner') {
    return options.auth?.partner;
  }
  return undefined;
}

export function createXyteClient(options: XyteClientOptions = {}): XyteClient {
  const profileStore: ProfileStore = options.profileStore ?? new FileProfileStore();
  const transport = options.transport ??
    new HttpTransport({
      timeoutMs: options.timeoutMs,
      retryAttempts: options.retryAttempts,
      retryBackoffMs: options.retryBackoffMs
    });

  let cachedSecretStore: SecretStore | undefined;

  const getSecretStore = (): SecretStore => {
    if (options.secretStore) {
      return options.secretStore;
    }
    if (!cachedSecretStore) {
      cachedSecretStore = createSecretStore();
    }
    return cachedSecretStore;
  };

  const resolveTenant = async (requestedTenantId?: string) => {
    const tenantId = requestedTenantId ?? options.tenantId ?? (await profileStore.getData()).activeTenantId;
    if (!tenantId) {
      return { tenantId: undefined, tenant: undefined };
    }
    return {
      tenantId,
      tenant: await profileStore.getTenant(tenantId)
    };
  };

  const getAuthHeader = async (endpoint: PublicEndpointSpec, tenantId?: string): Promise<string | undefined> => {
    if (endpoint.authScope === 'none') {
      return undefined;
    }

    const direct = directAuthValue(options, endpoint.authScope);
    if (direct) {
      return direct;
    }

    const provider = authProviderFromScope(endpoint.authScope);
    if (!provider) {
      return undefined;
    }

    if (!tenantId) {
      throw new XyteAuthError(
        `Endpoint ${endpoint.key} requires ${endpoint.authScope} API key. Provide a tenant via --tenant / profile default, or pass auth option.`
      );
    }

    const activeSlot = await profileStore.getActiveKeySlot(tenantId, provider);
    const slotId = activeSlot?.slotId ?? 'default';
    const secretStore = getSecretStore();
    const value = await secretStore.getSlotSecret(tenantId, provider, slotId);
    if (!value) {
      throw new XyteAuthError(
        `Missing API key for provider ${provider} in tenant ${tenantId} (slot ${slotId}). Use "xyte-cli config key add/use" or "xyte-cli setup run".`
      );
    }

    return value;
  };

  const callWithMeta = async <T = unknown>(endpointKey: string, args: XyteCallArgs = {}): Promise<XyteCallResult<T>> => {
    const endpoint = getEndpoint(endpointKey);
    const { tenantId, tenant } = await resolveTenant(args.tenantId);
    const baseUrl = endpoint.base === 'entry'
      ? tenant?.entryBaseUrl ?? options.entryBaseUrl ?? DEFAULT_ENTRY_BASE_URL
      : tenant?.hubBaseUrl ?? options.hubBaseUrl ?? DEFAULT_HUB_BASE_URL;

    const path = withPathParams(endpoint.pathTemplate, endpoint.pathParams, args.path);
    const url = withQueryParams(new URL(path, baseUrl), args.query);
    const authHeader = await getAuthHeader(endpoint, tenantId);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(args.headers ?? {})
    };

    if (authHeader && !headers.Authorization) {
      headers.Authorization = authHeader;
    }

    let body: string | FormData | undefined;
    if (endpoint.hasBody && args.body !== undefined) {
      if (endpoint.bodyType === 'multipart-form') {
        if (args.body instanceof FormData) {
          body = args.body;
        } else if (isRecord(args.body)) {
          const form = new FormData();
          for (const [key, value] of Object.entries(args.body)) {
            form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
          }
          body = form;
        } else {
          throw new XyteValidationError(`Endpoint ${endpoint.key} expects object/FormData for multipart body.`);
        }
      } else {
        headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
        body = JSON.stringify(args.body);
      }
    }

    const response = await transport.request<T>({
      requestId: args.requestId,
      endpointKey: endpoint.key,
      method: endpoint.method,
      url: url.toString(),
      headers,
      body,
      idempotent: ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(endpoint.method)
    });

    return {
      status: response.status,
      headers: response.headers,
      data: response.data,
      durationMs: response.meta?.durationMs ?? 0,
      retryCount: response.meta?.retryCount ?? 0,
      attempts: response.meta?.attempts ?? 1
    };
  };

  const call = async <T = unknown>(endpointKey: string, args: XyteCallArgs = {}): Promise<T> => {
    const result = await callWithMeta<T>(endpointKey, args);
    return result.data;
  };

  return {
    organization: createOrganizationNamespace(call),
    partner: createPartnerNamespace(call),
    call,
    callWithMeta,
    describeEndpoint: (key) => getEndpoint(key),
    listEndpoints: () => listEndpoints(),
    listTenantEndpoints: async (tenantId: string) => {
      const secretStore = getSecretStore();
      const [orgSlot, partnerSlot] = await Promise.all([
        profileStore.getActiveKeySlot(tenantId, PROVIDER_ORG),
        profileStore.getActiveKeySlot(tenantId, PROVIDER_PARTNER)
      ]);

      const [org, partner] = await Promise.all([
        secretStore.getSlotSecret(tenantId, PROVIDER_ORG, orgSlot?.slotId ?? 'default'),
        secretStore.getSlotSecret(tenantId, PROVIDER_PARTNER, partnerSlot?.slotId ?? 'default')
      ]);

      return listEndpoints().filter((endpoint) => {
        if (endpoint.authScope === 'none') {
          return true;
        }
        if (endpoint.authScope === 'organization') {
          return Boolean(org);
        }
        if (endpoint.authScope === 'partner') {
          return Boolean(partner);
        }
        return false;
      });
    }
  };
}
