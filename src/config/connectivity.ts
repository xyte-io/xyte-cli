import { XyteAuthError, XyteHttpError } from '../http/errors';
import type { XyteClient } from '../types/client';

export type ConnectionErrorClass = 'auth' | 'missing_key' | 'network' | 'timeout' | 'rate_limit' | 'unknown';

export type ConnectionState =
  | 'connected'
  | 'auth_required'
  | 'missing_key'
  | 'network_error'
  | 'timeout'
  | 'rate_limited'
  | 'unknown_error'
  | 'not_checked';

export interface ConnectivityResult {
  state: ConnectionState;
  class?: ConnectionErrorClass;
  message: string;
  retriable: boolean;
  endpointKey?: string;
  statusCode?: number;
}

export interface ConnectivityProbeOptions {
  client: XyteClient;
  tenantId?: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function classToState(kind: ConnectionErrorClass): ConnectionState {
  if (kind === 'auth') {
    return 'auth_required';
  }
  if (kind === 'missing_key') {
    return 'missing_key';
  }
  if (kind === 'network') {
    return 'network_error';
  }
  if (kind === 'timeout') {
    return 'timeout';
  }
  if (kind === 'rate_limit') {
    return 'rate_limited';
  }
  return 'unknown_error';
}

function isMissingKeyError(message: string): boolean {
  return /missing api key|requires .*api key|no active .*key/i.test(message);
}

export function isRetriableClass(kind: ConnectionErrorClass): boolean {
  return !['auth', 'missing_key'].includes(kind);
}

export function classifyConnectivityError(error: unknown): ConnectivityResult {
  const message = errorMessage(error);

  if (error instanceof XyteAuthError) {
    const kind: ConnectionErrorClass = isMissingKeyError(error.message) ? 'missing_key' : 'auth';
    return {
      state: classToState(kind),
      class: kind,
      message: error.message,
      retriable: isRetriableClass(kind)
    };
  }

  if (error instanceof XyteHttpError) {
    let kind: ConnectionErrorClass = 'unknown';
    if (error.status === 401 || error.status === 403) {
      kind = 'auth';
    } else if (error.status === 429) {
      kind = 'rate_limit';
    } else if (error.status === 408) {
      kind = 'timeout';
    } else if (error.status >= 500) {
      kind = 'network';
    } else if (isMissingKeyError(error.message)) {
      kind = 'missing_key';
    }

    return {
      state: classToState(kind),
      class: kind,
      message: error.message,
      retriable: isRetriableClass(kind),
      endpointKey: error.endpointKey,
      statusCode: error.status
    };
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return {
      state: 'timeout',
      class: 'timeout',
      message: message || 'Request timed out.',
      retriable: true
    };
  }

  if (error instanceof TypeError) {
    return {
      state: 'network_error',
      class: 'network',
      message: message || 'Network error.',
      retriable: true
    };
  }

  const maybeErrno = error as NodeJS.ErrnoException;
  if (typeof maybeErrno?.code === 'string' && ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(maybeErrno.code)) {
    const kind: ConnectionErrorClass = maybeErrno.code === 'ETIMEDOUT' ? 'timeout' : 'network';
    return {
      state: classToState(kind),
      class: kind,
      message,
      retriable: true
    };
  }

  if (isMissingKeyError(message)) {
    return {
      state: 'missing_key',
      class: 'missing_key',
      message,
      retriable: false
    };
  }

  return {
    state: 'unknown_error',
    class: 'unknown',
    message,
    retriable: true
  };
}

function preferFailure(a: ConnectivityResult, b: ConnectivityResult): ConnectivityResult {
  const rank = (result: ConnectivityResult): number => {
    if (result.state === 'connected') {
      return 0;
    }
    if (result.state === 'rate_limited') {
      return 1;
    }
    if (result.state === 'network_error') {
      return 2;
    }
    if (result.state === 'timeout') {
      return 3;
    }
    if (result.state === 'auth_required') {
      return 4;
    }
    if (result.state === 'missing_key') {
      return 5;
    }
    return 6;
  };

  return rank(a) >= rank(b) ? a : b;
}

export async function probeConnectivity(options: ConnectivityProbeOptions): Promise<ConnectivityResult> {
  try {
    await options.client.organization.getOrganizationInfo({ tenantId: options.tenantId });
    return {
      state: 'connected',
      message: 'Organization connectivity OK.',
      retriable: false,
      endpointKey: 'organization.getOrganizationInfo'
    };
  } catch (firstError) {
    const first = classifyConnectivityError(firstError);

    try {
      await options.client.partner.getDevices({ tenantId: options.tenantId });
      return {
        state: 'connected',
        message: 'Partner connectivity OK.',
        retriable: false,
        endpointKey: 'partner.devices.getDevices'
      };
    } catch (secondError) {
      const second = classifyConnectivityError(secondError);
      return preferFailure(first, second);
    }
  }
}
