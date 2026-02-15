export class XyteError extends Error {
  readonly code: string;

  constructor(message: string, code = 'XYTE_ERROR') {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
  }
}

export class XyteHttpError extends XyteError {
  readonly status: number;
  readonly statusText: string;
  readonly endpointKey?: string;
  readonly details?: unknown;

  constructor(args: {
    message: string;
    status: number;
    statusText: string;
    endpointKey?: string;
    details?: unknown;
  }) {
    super(args.message, 'XYTE_HTTP_ERROR');
    this.status = args.status;
    this.statusText = args.statusText;
    this.endpointKey = args.endpointKey;
    this.details = args.details;
  }
}

export class XyteAuthError extends XyteError {
  constructor(message: string) {
    super(message, 'XYTE_AUTH_ERROR');
  }
}

export class XyteValidationError extends XyteError {
  constructor(message: string) {
    super(message, 'XYTE_VALIDATION_ERROR');
  }
}
