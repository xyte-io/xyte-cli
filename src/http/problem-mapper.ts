import { XyteAuthError, XyteHttpError, XyteValidationError } from './errors';
import type { ProblemDetails } from '../contracts/problem';
import { isCliUserError } from '../contracts/user-error';
import { redactSensitiveData, redactSensitiveText } from '../utils/redact';

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return redactSensitiveText(error.message);
  }
  return redactSensitiveText(String(error));
}

export function toProblemDetails(error: unknown, instance?: string): ProblemDetails {
  if (isCliUserError(error)) {
    return {
      type: 'https://xyte.dev/problems/cli-user-error',
      title: error.summary,
      status: 400,
      detail: redactSensitiveText(error.message),
      instance,
      xyteCode: error.xyteCode,
      retriable: false,
      cause: error.detail ? redactSensitiveText(error.detail) : undefined,
      suggestedCommands: error.suggestedCommands.map((item) => redactSensitiveText(item))
    };
  }

  if (error instanceof XyteHttpError) {
    return {
      type: 'https://xyte.dev/problems/http-error',
      title: 'HTTP request failed',
      status: error.status,
      detail: redactSensitiveText(error.message),
      instance,
      xyteCode: error.code,
      retriable: error.status >= 500,
      upstream: redactSensitiveData(error.details)
    };
  }

  if (error instanceof XyteAuthError) {
    return {
      type: 'https://xyte.dev/problems/auth-error',
      title: 'Authentication required',
      status: 401,
      detail: redactSensitiveText(error.message),
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
      detail: redactSensitiveText(error.message),
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
