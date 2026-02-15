export type CliErrorFormat = 'text' | 'json';

function isCliErrorFormat(value: string | undefined): value is CliErrorFormat {
  return value === 'text' || value === 'json';
}

export function parseErrorFormatArg(argv: string[]): CliErrorFormat | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--error-format') {
      const next = argv[index + 1];
      if (isCliErrorFormat(next)) {
        return next;
      }
      continue;
    }

    if (arg.startsWith('--error-format=')) {
      const value = arg.slice('--error-format='.length);
      if (isCliErrorFormat(value)) {
        return value;
      }
    }
  }

  return undefined;
}

export function resolveCliErrorFormat(argv: string[], envValue?: string): CliErrorFormat {
  const fromArg = parseErrorFormatArg(argv);
  if (fromArg) {
    return fromArg;
  }
  return envValue === 'json' ? 'json' : 'text';
}
