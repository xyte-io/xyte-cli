import { PassThrough } from 'node:stream';

import blessed from 'blessed';
import { vi, type Mock, type MockedFunction } from 'vitest';

import { HttpTransport } from '../../src/http/transport';
import type { ReadinessCheck } from '../../src/contracts/status';
import { MemorySecretStore } from '../../src/secure/secret-store';
import type { TuiContext } from '../../src/tui/types';
import type {
  NamespaceCall,
  OrganizationNamespace,
  PartnerNamespace,
  XyteCallArgs,
  XyteCallResult,
  XyteClient
} from '../../src/types/client';
import type { PublicEndpointSpec } from '../../src/types/endpoints';
import { MemoryProfileStore } from './memory-profile-store';

export type MockNamespaceCall = ReturnType<typeof makeNamespaceCall>;
export interface PublicTransportRequest {
  requestId?: string;
  endpointKey?: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | FormData;
  idempotent?: boolean;
  timeoutMs?: number;
}

export interface PublicTransportResponse<T = unknown> {
  status: number;
  headers: Record<string, string>;
  data: T;
  meta: {
    durationMs: number;
    attempts: number;
    retryCount: number;
  };
}

export type HttpTransportRequestMock = Mock<
  (request: PublicTransportRequest) => Promise<PublicTransportResponse>
>;
export type CallWithMetaHandler = (
  endpointKey: string,
  args?: XyteCallArgs
) => Promise<XyteCallResult<unknown>>;
export type MockCallWithMetaHandler = MockedFunction<CallWithMetaHandler>;

export function makeNamespaceCall(result: unknown = {}): MockedFunction<NamespaceCall> {
  return vi.fn(async (_args?: XyteCallArgs) => result);
}

export function makeCallWithMeta(
  handler: CallWithMetaHandler = async () => ({
    status: 200,
    headers: {},
    data: undefined,
    durationMs: 0,
    retryCount: 0,
    attempts: 1
  })
): XyteClient['callWithMeta'] {
  return async <T = unknown>(
    endpointKey: string,
    args?: XyteCallArgs
  ): Promise<XyteCallResult<T>> => {
    const result = await handler(endpointKey, args);
    return { ...result, data: result.data as T };
  };
}

export function makeCallWithMetaHandler(handler: CallWithMetaHandler): MockCallWithMetaHandler {
  return vi.fn(handler);
}

export function makeOrganizationNamespace(
  overrides: Partial<OrganizationNamespace> = {}
): OrganizationNamespace {
  return {
    closeIncident: makeNamespaceCall(),
    cancelCommand: makeNamespaceCall(),
    getCommands: makeNamespaceCall(),
    sendCommand: makeNamespaceCall(),
    claimDevice: makeNamespaceCall(),
    moveDevice: makeNamespaceCall(),
    suspendIncidents: makeNamespaceCall(),
    resumeIncidents: makeNamespaceCall(),
    updateDevice: makeNamespaceCall(),
    deleteDevice: makeNamespaceCall(),
    getDevice: makeNamespaceCall(),
    getDevices: makeNamespaceCall(),
    getHistories: makeNamespaceCall(),
    getEdges: makeNamespaceCall(),
    getOrganizationInfo: makeNamespaceCall(),
    addExternalUser: makeNamespaceCall(),
    addUsers: makeNamespaceCall(),
    createGroup: makeNamespaceCall(),
    deleteGroup: makeNamespaceCall(),
    getGroup: makeNamespaceCall(),
    getGroups: makeNamespaceCall(),
    removeUsers: makeNamespaceCall(),
    updateGroup: makeNamespaceCall(),
    getIncidents: makeNamespaceCall(),
    createSpace: makeNamespaceCall(),
    deleteSpace: makeNamespaceCall(),
    findOrCreateSpace: makeNamespaceCall(),
    getSpace: makeNamespaceCall(),
    getSpaces: makeNamespaceCall(),
    updateSpace: makeNamespaceCall(),
    getTicket: makeNamespaceCall(),
    getTickets: makeNamespaceCall(),
    markResolved: makeNamespaceCall(),
    sendMessage: makeNamespaceCall(),
    updateTicket: makeNamespaceCall(),
    startEdgeClaim: makeNamespaceCall(),
    getEdgeClaimStatus: makeNamespaceCall(),
    startEdgePing: makeNamespaceCall(),
    getEdgePingStatus: makeNamespaceCall(),
    createUser: makeNamespaceCall(),
    deactivateUser: makeNamespaceCall(),
    getUser: makeNamespaceCall(),
    getUsers: makeNamespaceCall(),
    resendWelcome: makeNamespaceCall(),
    ...overrides
  };
}

export function makePartnerNamespace(overrides: Partial<PartnerNamespace> = {}): PartnerNamespace {
  return {
    deleteDevice: makeNamespaceCall(),
    getCommands: makeNamespaceCall(),
    getConfiguration: makeNamespaceCall(),
    getDeviceInfo: makeNamespaceCall(),
    getDevices: makeNamespaceCall(),
    getStateHistory: makeNamespaceCall(),
    getStateHistoryMultiDevices: makeNamespaceCall(),
    getTelemetries: makeNamespaceCall(),
    createOrganization: makeNamespaceCall(),
    addComment: makeNamespaceCall(),
    closeTicket: makeNamespaceCall(),
    getTicket: makeNamespaceCall(),
    getTickets: makeNamespaceCall(),
    updateTicket: makeNamespaceCall(),
    ...overrides
  };
}

export function makeEndpointSpec(overrides: Partial<PublicEndpointSpec> = {}): PublicEndpointSpec {
  return {
    key: 'test.endpoint',
    namespace: 'organization',
    group: 'test',
    action: 'test',
    title: 'Test Endpoint',
    method: 'GET',
    base: 'hub',
    pathTemplate: '/test',
    pathParams: [],
    queryParams: [],
    authScope: 'organization',
    bodyType: 'none',
    hasBody: false,
    sourceFile: 'test',
    ...overrides
  };
}

export function makeXyteClientMock(overrides: {
  organization?: Partial<OrganizationNamespace>;
  partner?: Partial<PartnerNamespace>;
  call?: XyteClient['call'];
  callWithMeta?: XyteClient['callWithMeta'];
  describeEndpoint?: XyteClient['describeEndpoint'];
  listEndpoints?: XyteClient['listEndpoints'];
  listTenantEndpoints?: XyteClient['listTenantEndpoints'];
} = {}): XyteClient {
  const call: XyteClient['call'] = async <T = unknown>() => undefined as T;
  return {
    organization: makeOrganizationNamespace(overrides.organization),
    partner: makePartnerNamespace(overrides.partner),
    call: overrides.call ?? call,
    callWithMeta: overrides.callWithMeta ?? makeCallWithMeta(),
    describeEndpoint: overrides.describeEndpoint ?? (() => makeEndpointSpec()),
    listEndpoints: overrides.listEndpoints ?? (() => []),
    listTenantEndpoints: overrides.listTenantEndpoints ?? (async () => [])
  };
}

export function makeHttpTransportMock(
  response: PublicTransportResponse = {
    status: 200,
    headers: {},
    data: { ok: true },
    meta: { durationMs: 0, attempts: 1, retryCount: 0 }
  }
): { transport: HttpTransport; request: HttpTransportRequestMock } {
  const transport = new HttpTransport();
  const request: HttpTransportRequestMock = vi.fn(async () => response);
  vi.spyOn(transport, 'request').mockImplementation(async <T = unknown>(
    transportRequest: PublicTransportRequest
  ) => {
    const result = await request(transportRequest);
    return { ...result, data: result.data as T };
  });
  return { transport, request };
}

export function makeTuiContext(overrides: Partial<TuiContext> = {}): TuiContext {
  const screen = blessed.screen({
    input: new PassThrough(),
    output: new PassThrough(),
    smartCSR: false
  });

  const readyReadiness: ReadinessCheck = {
    state: 'ready',
    connectionState: 'connected',
    connectivity: {
      state: 'connected',
      message: 'Connected',
      retriable: false
    },
    missingItems: [],
    recommendedActions: [],
    providers: []
  };

  return {
    screen,
    client: makeXyteClientMock(),
    profileStore: new MemoryProfileStore(),
    secretStore: new MemorySecretStore(),
    getActiveTenantId: vi.fn(async () => 'acme'),
    getReadiness: vi.fn(() => undefined),
    refreshReadiness: vi.fn(async () => readyReadiness),
    setStatus: vi.fn(),
    showError: vi.fn(),
    prompt: vi.fn(async () => undefined),
    promptSecret: vi.fn(async () => undefined),
    confirmWrite: vi.fn(async () => true),
    ...overrides
  };
}
