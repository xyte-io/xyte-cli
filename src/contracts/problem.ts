import { XyteAuthError, XyteHttpError, XyteValidationError } from '../http/errors';

export interface ProblemDetails {
  type: string;
  title: string;
  status?: number;
  detail: string;
  instance?: string;
  xyteCode: string;
  retriable: boolean;
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function toProblemDetails(error: unknown, instance?: string): ProblemDetails {
  if (error instanceof XyteHttpError) {
    return {
      type: 'https://xyte.dev/problems/http-error',
      title: 'HTTP request failed',
      status: error.status,
      detail: error.message,
      instance,
      xyteCode: error.code,
      retriable: error.status >= 500
    };
  }

  if (error instanceof XyteAuthError) {
    return {
      type: 'https://xyte.dev/problems/auth-error',
      title: 'Authentication required',
      status: 401,
      detail: error.message,
      instance,
      xyteCode: error.code,
      retriable: false
    };
  }

  if (error instanceof XyteValidationError) {
    return {
      type: 'https://xyte.dev/problems/validation-error',
      title: 'Invalid request',
      status: 400,
      detail: error.message,
      instance,
      xyteCode: error.code,
      retriable: false
    };
  }

  return {
    type: 'about:blank',
    title: 'Unhandled error',
    status: 500,
    detail: toMessage(error),
    instance,
    xyteCode: 'XYTE_UNHANDLED_ERROR',
    retriable: false
  };
}
