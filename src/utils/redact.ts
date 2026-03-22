const REDACTED = '[REDACTED]';

const SENSITIVE_FIELDS = [
  'api_key',
  'apikey',
  'x_api_key',
  'token',
  'access_token',
  'refresh_token',
  'secret',
  'client_secret',
  'private_key',
  'password',
  'passwd',
  'pwd',
  'authorization',
  'bearer',
  'session_id'
];

function isSensitiveFieldName(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_FIELDS.some((field) => normalized.includes(field.replace(/[^a-z0-9]/gi, '')));
}

function redactValueToken(value: string): string {
  return value.replace(/^[^=\s:]{3,}$/, REDACTED);
}

export function redactSensitiveText(input: string): string {
  let output = input;

  output = output.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{6,}\b/gi, `$1 ${REDACTED}`);

  output = output.replace(
    /([?&](?:api[_-]?key|x[_-]?api[_-]?key|token|access_token|refresh_token|client_secret)=)([^&#\s]+)/gi,
    (_match, prefix, value: string) => `${prefix}${redactValueToken(value)}`
  );

  output = output.replace(
    /((?:^|[\s,{;])["']?(?:api[_-]?key|x[_-]?api[_-]?key|token|access_token|refresh_token|secret|client_secret|private_key|password|passwd|authorization)["']?\s*(?:=|:)\s*)(["']?)((?:Bearer\s+[^\s"',}]+)|[^"',\s}]+)(\2)/gi,
    (_match, prefix, quoteStart, _value: string, quoteEnd) => `${prefix}${quoteStart}${REDACTED}${quoteEnd}`
  );

  return output;
}

function redactInternal(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return seen.get(value);
  }

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) {
      output.push(redactInternal(item, seen));
    }
    return output;
  }

  const output: Record<string, unknown> = {};
  seen.set(value, output);
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveFieldName(key) && nested !== null && nested !== undefined) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = redactInternal(nested, seen);
  }
  return output;
}

export function redactSensitiveData<T>(value: T): T {
  return redactInternal(value, new WeakMap<object, unknown>()) as T;
}

export function redactForDisplay(value: string, includeSensitive: boolean): string {
  if (includeSensitive || value === 'n/a') {
    return value;
  }
  if (value.length <= 8) {
    return '***';
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}
