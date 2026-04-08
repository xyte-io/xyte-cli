export interface CliUserErrorOptions {
  summary: string;
  cause?: string;
  suggestedCommands?: string[];
  xyteCode?: string;
}

export class CliUserError extends Error {
  readonly summary: string;
  readonly cause?: string;
  readonly suggestedCommands: string[];
  readonly xyteCode: string;

  constructor(options: CliUserErrorOptions) {
    super(options.summary);
    this.name = 'CliUserError';
    this.summary = options.summary;
    this.cause = options.cause;
    this.suggestedCommands = options.suggestedCommands ?? [];
    this.xyteCode = options.xyteCode ?? 'XYTE_CLI_USER_ERROR';
  }
}

export function isCliUserError(error: unknown): error is CliUserError {
  return error instanceof CliUserError;
}
