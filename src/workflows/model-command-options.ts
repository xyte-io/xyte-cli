import { isRecord } from '../utils/json';

export type ModelCommandOptionValue = string | number | boolean | null;

export interface ModelCommandOption {
  label: string;
  value: ModelCommandOptionValue;
}

export interface ModelCommandOptionSet {
  options: ModelCommandOption[];
  issues: string[];
}

export type ModelCommandOptionMatch =
  | { status: 'matched'; value: ModelCommandOptionValue }
  | { status: 'ambiguous' }
  | { status: 'unmatched' };

function isOptionValue(value: unknown): value is ModelCommandOptionValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function scalarText(value: unknown): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function isNumericCode(value: string): boolean {
  return /^-?\d+(?:\.\d+)?$/.test(value.trim());
}

function optionFromRecord(
  fallbackValue: ModelCommandOptionValue | undefined,
  record: Record<string, unknown>
): ModelCommandOption | undefined {
  const hasValue = Object.prototype.hasOwnProperty.call(record, 'value');
  const hasId = Object.prototype.hasOwnProperty.call(record, 'id');
  let value = fallbackValue;
  if (hasValue) {
    if (!isOptionValue(record.value)) return undefined;
    value = record.value;
  } else if (hasId) {
    if (!isOptionValue(record.id)) return undefined;
    value = record.id;
  }
  if (value === undefined) return undefined;
  const label =
    scalarText(record.label) ?? scalarText(record.title) ?? scalarText(record.name) ?? scalarText(fallbackValue);
  return label ? { label, value } : undefined;
}

function normalizeArrayOptions(raw: unknown[]): ModelCommandOptionSet {
  const options: ModelCommandOption[] = [];
  const issues: string[] = [];
  raw.forEach((entry, index) => {
    if (isOptionValue(entry)) {
      options.push({ label: String(entry), value: entry });
      return;
    }
    if (isRecord(entry)) {
      const option = optionFromRecord(undefined, entry);
      if (option) {
        options.push(option);
        return;
      }
    }
    issues.push(`option ${index + 1} has no scalar value`);
  });
  return { options, issues };
}

function normalizePrimitiveMapOption(key: string, raw: ModelCommandOptionValue): ModelCommandOption | undefined {
  if (typeof raw !== 'string') {
    return { label: key, value: raw };
  }

  const keyIsCode = isNumericCode(key);
  const valueIsCode = isNumericCode(raw);
  if (keyIsCode === valueIsCode) {
    return undefined;
  }
  return keyIsCode ? { label: raw, value: key } : { label: key, value: raw };
}

function normalizeMappedOptions(raw: Record<string, unknown>): ModelCommandOptionSet {
  const options: ModelCommandOption[] = [];
  const issues: string[] = [];
  for (const [key, entry] of Object.entries(raw)) {
    const option = isRecord(entry)
      ? optionFromRecord(key, entry)
      : isOptionValue(entry)
        ? normalizePrimitiveMapOption(key, entry)
        : undefined;
    if (option) {
      options.push(option);
    } else {
      issues.push(`option ${JSON.stringify(key)} has ambiguous or invalid metadata`);
    }
  }
  return { options, issues };
}

export function extractModelCommandOptionSet(field: Record<string, unknown>): ModelCommandOptionSet | undefined {
  if (typeof field.type !== 'string' || field.type.trim().toLowerCase() !== 'select') {
    return undefined;
  }
  const raw = field.options;
  if (Array.isArray(raw)) {
    return normalizeArrayOptions(raw);
  }
  if (isRecord(raw)) {
    return normalizeMappedOptions(raw);
  }
  return raw === undefined ? undefined : { options: [], issues: ['options must be an array or object'] };
}

function valuesEqual(left: ModelCommandOptionValue, right: ModelCommandOptionValue): boolean {
  return typeof left === typeof right && Object.is(left, right);
}

function normalizedText(value: ModelCommandOptionValue): string {
  return String(value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function distinctValues(options: ModelCommandOption[]): ModelCommandOptionValue[] {
  const values: ModelCommandOptionValue[] = [];
  for (const option of options) {
    if (!values.some((value) => valuesEqual(value, option.value))) {
      values.push(option.value);
    }
  }
  return values;
}

export function matchModelCommandOption(options: ModelCommandOption[], input: unknown): ModelCommandOptionMatch {
  if (!isOptionValue(input)) {
    return { status: 'unmatched' };
  }

  const exactValues = distinctValues(options.filter((option) => valuesEqual(option.value, input)));
  if (exactValues.length === 1) {
    return { status: 'matched', value: exactValues[0] };
  }

  const inputText = normalizedText(input);
  const matchedValues = distinctValues(
    options.filter((option) => normalizedText(option.value) === inputText || normalizedText(option.label) === inputText)
  );
  if (matchedValues.length === 1) {
    return { status: 'matched', value: matchedValues[0] };
  }
  return matchedValues.length > 1 ? { status: 'ambiguous' } : { status: 'unmatched' };
}
