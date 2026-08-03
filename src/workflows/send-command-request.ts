import { isRecord } from '../utils/json';

export interface SendCommandRequestBodyInspection {
  hasName: boolean;
  hasParams: boolean;
  hasInvalidExtraParams: boolean;
}

export function inspectSendCommandRequestBody(body: unknown): SendCommandRequestBodyInspection | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  return {
    hasName: Object.prototype.hasOwnProperty.call(body, 'name'),
    hasParams: Object.prototype.hasOwnProperty.call(body, 'params'),
    hasInvalidExtraParams: Object.prototype.hasOwnProperty.call(body, 'extra_params') && !isRecord(body.extra_params)
  };
}
