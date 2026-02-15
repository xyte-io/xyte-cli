export interface JsonWriteOptions {
  strictJson?: boolean;
}

function safeStringify(value: unknown): string {
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
    2
  );
}

export function stringifyForOutput(value: unknown, options: JsonWriteOptions = {}): string {
  if (options.strictJson) {
    return JSON.stringify(value, null, 2);
  }
  return safeStringify(value);
}

export function writeJsonLine(
  stream: Pick<typeof process.stdout, 'write'>,
  value: unknown,
  options: JsonWriteOptions = {}
): void {
  const text = stringifyForOutput(value, options);
  stream.write(`${text}\n`);
}
