import { CliUserError } from '../contracts/user-error';

export type CliErrorFormat = 'text' | 'json';

function isCliErrorFormat(value: string | undefined): value is CliErrorFormat {
  return value === 'text' || value === 'json';
}

export function parseCliErrorFormat(value: string | undefined): CliErrorFormat | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!isCliErrorFormat(normalized)) {
    throw new CliUserError({
      summary: 'Invalid error format.',
      detail: `Received "${value}".`,
      suggestedCommands: ['Use --error-format text', 'Use --error-format json']
    });
  }
  return normalized;
}

export function parseErrorFormatArg(argv: string[]): CliErrorFormat | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--error-format') {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new CliUserError({
          summary: 'Missing error format value.',
          suggestedCommands: ['Use --error-format text', 'Use --error-format json']
        });
      }
      return parseCliErrorFormat(next);
    }

    if (arg.startsWith('--error-format=')) {
      const value = arg.slice('--error-format='.length);
      return parseCliErrorFormat(value);
    }
  }

  return undefined;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function resolveCliErrorFormat(argv: string[], envValue?: string): CliErrorFormat {
  const fromArg = parseErrorFormatArg(argv);
  if (fromArg) {
    return fromArg;
  }
  return envValue === 'json' ? 'json' : 'text';
}
