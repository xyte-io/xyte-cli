interface JsonWriteOptions {
  strictJson?: boolean;
  compact?: boolean;
}

function safeStringify(value: unknown, spacing: number): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, item) => {
      if (typeof item === 'bigint') {
        return item.toString();
      }

      if (item && typeof item === 'object') {
        if (seen.has(item as object)) {
          return '[Circular]';
        }
        seen.add(item as object);
      }

      return item;
    },
    spacing
  );
}

export function stringifyJsonOutput(value: unknown, options: JsonWriteOptions = {}): string {
  const spacing = options.compact ? 0 : 2;
  if (options.strictJson) {
    return JSON.stringify(value, null, spacing);
  }
  return safeStringify(value, spacing);
}

export function writeJsonLine(
  stream: Pick<typeof process.stdout, 'write'>,
  value: unknown,
  options: JsonWriteOptions = {}
): void {
  const text = stringifyJsonOutput(value, options);
  stream.write(`${text}\n`);
}
