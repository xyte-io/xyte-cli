import { isRecord } from '../utils/json';

export type ModelCommandOptionValue = string | number | boolean;
export type ModelCommandOptionInput = ModelCommandOptionValue | ModelCommandOptionValue[];
export type ModelCommandOptionCardinality = 'single' | 'multiple' | 'unknown';

export const MODEL_COMMAND_PATH_OPTIONS_ISSUE = 'path-backed command options are not embedded in model metadata';

export interface ModelCommandOption {
  label: string;
  value: ModelCommandOptionValue;
}

export interface ModelCommandOptionSet {
  cardinality: ModelCommandOptionCardinality;
  options: ModelCommandOption[];
  issues: string[];
}

export type ModelCommandOptionMatch =
  | { status: 'matched'; value: ModelCommandOptionInput }
  | { status: 'ambiguous' }
  | { status: 'invalid-cardinality' }
  | { status: 'unmatched' };

type ScalarModelCommandOptionMatch =
  | { status: 'matched'; value: ModelCommandOptionValue }
  | { status: 'ambiguous' }
  | { status: 'unmatched' };

interface NormalizedModelCommandOptions {
  options: ModelCommandOption[];
  issues: string[];
}

function isOptionValue(value: unknown): value is ModelCommandOptionValue {
  return (
    (typeof value === 'string' && value.trim().length > 0) ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function scalarText(value: unknown): string | undefined {
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
  if (!isOptionValue(value)) return undefined;
  const label =
    scalarText(record.label) ?? scalarText(record.title) ?? scalarText(record.name) ?? scalarText(fallbackValue);
  return label ? { label, value } : undefined;
}

function normalizeArrayOptions(raw: unknown[]): NormalizedModelCommandOptions {
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

function normalizeMappedOptions(raw: Record<string, unknown>): NormalizedModelCommandOptions {
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

function normalizedIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

function cardinalityFromType(type: string | undefined): Exclude<ModelCommandOptionCardinality, 'unknown'> | undefined {
  return type === 'select' ? 'single' : type === 'multiselect' ? 'multiple' : undefined;
}

function cardinalityFromTypeName(
  typeName: string | undefined
): Exclude<ModelCommandOptionCardinality, 'unknown'> | undefined {
  return typeName === 'staticlistsingle' || typeName === 'dynamiclistsingle'
    ? 'single'
    : typeName === 'staticlistmulti' || typeName === 'dynamiclistmulti'
      ? 'multiple'
      : undefined;
}

function optionCardinality(field: Record<string, unknown>): {
  cardinality: ModelCommandOptionCardinality;
  issues: string[];
} {
  const type = normalizedIdentifier(field.type);
  const typeName = normalizedIdentifier(field.typeName);
  const hasTypeName = Object.prototype.hasOwnProperty.call(field, 'typeName');
  const typeCardinality = cardinalityFromType(type);
  const typeNameCardinality = cardinalityFromTypeName(typeName);
  const issues: string[] = [];

  if (!type) {
    issues.push('option-backed field type is missing');
  } else if (!typeCardinality) {
    issues.push(`field type ${JSON.stringify(field.type)} does not define option cardinality`);
  }
  if (hasTypeName && !typeName) {
    issues.push('field typeName must be a non-empty string when provided');
  } else if (typeName && !typeNameCardinality) {
    issues.push(`field typeName ${JSON.stringify(field.typeName)} is not a supported command option type`);
  }
  if (typeCardinality && typeNameCardinality && typeCardinality !== typeNameCardinality) {
    issues.push('field type and typeName define conflicting option cardinality');
  }

  const cardinality = typeCardinality ?? typeNameCardinality;
  if (!cardinality && issues.length === 0) {
    issues.push('field options do not define single- or multi-value cardinality');
  }
  return { cardinality: issues.length === 0 && cardinality ? cardinality : 'unknown', issues };
}

export function extractModelCommandOptionSet(field: Record<string, unknown>): ModelCommandOptionSet | undefined {
  const raw = field.options;
  const hasPath = Object.prototype.hasOwnProperty.call(field, 'path');
  const hasDynamicOptionsPath = typeof field.path === 'string' && field.path.trim().length > 0;
  const type = normalizedIdentifier(field.type);
  const typeName = normalizedIdentifier(field.typeName);
  const hasListIntent = cardinalityFromType(type) !== undefined || cardinalityFromTypeName(typeName) !== undefined;
  if (raw === undefined && !hasDynamicOptionsPath && !hasListIntent) {
    return undefined;
  }

  const fieldCardinality = optionCardinality(field);
  const issues = [...fieldCardinality.issues];
  const isStaticTypeName = typeName === 'staticlistsingle' || typeName === 'staticlistmulti';
  const isDynamicTypeName = typeName === 'dynamiclistsingle' || typeName === 'dynamiclistmulti';

  if (hasPath && !hasDynamicOptionsPath) {
    issues.push('field path must be a non-empty string when provided');
  }
  if (isStaticTypeName && hasDynamicOptionsPath) {
    issues.push('static command options cannot use a dynamic path');
  }
  if (isDynamicTypeName && raw !== undefined) {
    issues.push('dynamic command options cannot also embed static options');
  }
  if (isDynamicTypeName && !hasDynamicOptionsPath) {
    issues.push('dynamic command options require a path');
  }
  if (!typeName && raw !== undefined && hasDynamicOptionsPath) {
    issues.push('command options cannot define both embedded options and a dynamic path');
  }
  if (hasDynamicOptionsPath && !isStaticTypeName) {
    issues.push(MODEL_COMMAND_PATH_OPTIONS_ISSUE);
  }
  if (raw === undefined && !hasDynamicOptionsPath) {
    issues.push('option-backed field does not include model-defined choices');
  }

  let normalized: NormalizedModelCommandOptions = { options: [], issues: [] };
  if (Array.isArray(raw)) {
    normalized = normalizeArrayOptions(raw);
  } else if (isRecord(raw)) {
    normalized = normalizeMappedOptions(raw);
  } else if (raw !== undefined) {
    normalized = { options: [], issues: ['options must be an array or object'] };
  }
  return {
    cardinality: fieldCardinality.cardinality,
    options: normalized.options,
    issues: [...issues, ...normalized.issues]
  };
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

function matchScalarModelCommandOption(options: ModelCommandOption[], input: unknown): ScalarModelCommandOptionMatch {
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

export function matchModelCommandOption(optionSet: ModelCommandOptionSet, input: unknown): ModelCommandOptionMatch {
  if (optionSet.cardinality === 'unknown') {
    return { status: 'invalid-cardinality' };
  }
  if (optionSet.cardinality === 'single') {
    return Array.isArray(input)
      ? { status: 'invalid-cardinality' }
      : matchScalarModelCommandOption(optionSet.options, input);
  }
  if (!Array.isArray(input)) {
    return { status: 'invalid-cardinality' };
  }

  const values: ModelCommandOptionValue[] = [];
  for (const entry of input) {
    const match = matchScalarModelCommandOption(optionSet.options, entry);
    if (match.status !== 'matched') {
      return match.status === 'ambiguous' ? { status: 'ambiguous' } : { status: 'unmatched' };
    }
    values.push(match.value);
  }
  return { status: 'matched', value: values };
}
