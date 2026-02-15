export interface SafeInspectOptions {
  maxDepth?: number;
  maxArrayItems?: number;
  maxObjectKeys?: number;
  maxOutputChars?: number;
  compact?: boolean;
}

export interface SafeInspectResult {
  text: string;
  truncated: boolean;
  approxSize: number;
  keyCount: number;
}

interface SafeInspectState {
  seen: WeakSet<object>;
  truncated: boolean;
  approxSize: number;
  keyCount: number;
}

const DEFAULT_OPTIONS: Required<SafeInspectOptions> = {
  maxDepth: 6,
  maxArrayItems: 50,
  maxObjectKeys: 80,
  maxOutputChars: 40_000,
  compact: false
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function sanitizeValue(
  value: unknown,
  depth: number,
  options: Required<SafeInspectOptions>,
  state: SafeInspectState
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') {
    state.approxSize += String(value).length;
    return value;
  }
  if (valueType === 'bigint') {
    state.approxSize += String(value).length;
    return `${value}n`;
  }
  if (valueType === 'function') {
    state.truncated = true;
    return '[Function]';
  }
  if (valueType !== 'object') {
    return String(value);
  }

  const objectValue = value as object;
  if (state.seen.has(objectValue)) {
    state.truncated = true;
    return '[Circular]';
  }
  if (depth >= options.maxDepth) {
    state.truncated = true;
    return '[DepthLimit]';
  }

  state.seen.add(objectValue);
  try {
    if (Array.isArray(value)) {
      const arrayValue = value as unknown[];
      const limit = Math.min(arrayValue.length, options.maxArrayItems);
      const next: unknown[] = [];
      for (let index = 0; index < limit; index += 1) {
        next.push(sanitizeValue(arrayValue[index], depth + 1, options, state));
      }
      if (arrayValue.length > limit) {
        state.truncated = true;
        next.push(`[Truncated ${arrayValue.length - limit} items]`);
      }
      return next;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const limit = Math.min(keys.length, options.maxObjectKeys);
    const next: Record<string, unknown> = {};
    for (let index = 0; index < limit; index += 1) {
      const key = keys[index];
      state.keyCount += 1;
      state.approxSize += key.length;
      next[key] = sanitizeValue(record[key], depth + 1, options, state);
    }
    if (keys.length > limit) {
      state.truncated = true;
      next['[Truncated]'] = `${keys.length - limit} keys omitted`;
    }
    return next;
  } finally {
    state.seen.delete(objectValue);
  }
}

export function safeInspect(value: unknown, options: SafeInspectOptions = {}): SafeInspectResult {
  const merged: Required<SafeInspectOptions> = { ...DEFAULT_OPTIONS, ...options };
  const state: SafeInspectState = {
    seen: new WeakSet<object>(),
    truncated: false,
    approxSize: 0,
    keyCount: 0
  };

  let text: string;
  try {
    const sanitized = sanitizeValue(value, 0, merged, state);
    text = JSON.stringify(sanitized, null, merged.compact ? 0 : 2);
  } catch (error) {
    state.truncated = true;
    const message = error instanceof Error ? error.message : String(error);
    text = JSON.stringify({ error: `Serialization failed: ${message}` }, null, merged.compact ? 0 : 2);
  }

  if (text.length > merged.maxOutputChars) {
    state.truncated = true;
    text = `${text.slice(0, merged.maxOutputChars)}\n[Truncated]`;
  }

  return {
    text,
    truncated: state.truncated,
    approxSize: state.approxSize,
    keyCount: state.keyCount
  };
}

export function payloadSummary(value: unknown): { kind: string; approxSize: number; keyCount: number; truncated: boolean } {
  const inspected = safeInspect(value, {
    compact: true,
    maxOutputChars: 8_000
  });
  const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  return {
    kind,
    approxSize: inspected.approxSize,
    keyCount: inspected.keyCount,
    truncated: inspected.truncated
  };
}

export function summarizeObject(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  const lines: string[] = [];
  const id = record.id ?? record._id ?? record.uuid;
  const name = record.name ?? record.title ?? record.subject;
  const status = record.status ?? record.state;
  const severity = record.severity ?? record.priority;
  const deviceId = record.device_id ?? record.deviceId;

  if (id !== undefined) {
    lines.push(`id: ${String(id)}`);
  }
  if (name !== undefined) {
    lines.push(`name: ${String(name)}`);
  }
  if (status !== undefined) {
    lines.push(`status: ${String(status)}`);
  }
  if (severity !== undefined) {
    lines.push(`severity: ${String(severity)}`);
  }
  if (deviceId !== undefined) {
    lines.push(`device: ${String(deviceId)}`);
  }
  return lines;
}

export function safeLines(value: unknown, options: SafeInspectOptions = {}): { lines: string[]; truncated: boolean } {
  const inspected = safeInspect(value, options);
  return {
    lines: inspected.text.split('\n'),
    truncated: inspected.truncated
  };
}

export function safePreviewLines(value: unknown, options: SafeInspectOptions = {}): { lines: string[]; truncated: boolean } {
  const result = safeLines(value, options);
  if (!result.truncated) {
    return result;
  }
  const summary = summarizeObject(value);
  const lines = ['Preview truncated for stability.', ...summary, ...result.lines];
  return {
    lines,
    truncated: true
  };
}

export function safeSearchText(value: unknown, options: SafeInspectOptions = {}): string {
  const inspected = safeInspect(value, {
    compact: true,
    maxOutputChars: 20_000,
    ...options
  });
  return inspected.text.toLowerCase();
}
