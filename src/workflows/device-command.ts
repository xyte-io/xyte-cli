import type { XyteClient } from '../types/client';
import { isRecord } from '../utils/json';
import {
  extractSentCommandId,
  MAX_COMMAND_POLL_DELAY_MS,
  pollCommandStatus,
  type CommandPollResult
} from './command-poll';
import { parsePositiveInt as parseEdgePollPositiveInt } from './edge-poll';
import type { FlowStep, FlowTaskStep } from './flow-catalog';
import {
  extractModelCommandOptionSet,
  matchModelCommandOption,
  MODEL_COMMAND_PATH_OPTIONS_ISSUE,
  type ModelCommandOptionSet
} from './model-command-options';
import { inspectSendCommandRequestBody } from './send-command-request';

const SEND_COMMAND_ENDPOINT = 'organization.commands.sendCommand';

export class DeviceCommandNeedsInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DeviceCommandNeedsInputError';
  }
}

type ModelCommandValueKind = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'unsupported';

interface DeclaredModelCommandValueType {
  raw: string;
  kind: ModelCommandValueKind;
}

interface ModelCommandCustomFieldDefinition {
  required: boolean;
  optionSet?: ModelCommandOptionSet;
  declaredType?: DeclaredModelCommandValueType;
}

interface ModelCommandDefinition {
  name?: string;
  friendlyName?: string;
  customFields: Map<string, ModelCommandCustomFieldDefinition>;
  withFile: boolean;
  issues: string[];
}

type CommandSelectorEntry = { status: 'unique'; command: ModelCommandDefinition } | { status: 'ambiguous' };

interface ModelCommandCandidates {
  byName: Map<string, CommandSelectorEntry>;
  byFriendlyName: Map<string, CommandSelectorEntry>;
}

export interface DeviceCommandModelEvidence {
  modelId: string;
  modelData: unknown;
}

export type DeviceCommandPollStepResult =
  | { ok: true; output: CommandPollResult | { outcome: 'not_requested' } }
  | { ok: false; failureDetail: string; output?: CommandPollResult };

function addCommandSelector(
  index: Map<string, CommandSelectorEntry>,
  selector: string,
  command: ModelCommandDefinition
): void {
  index.set(selector, index.has(selector) ? { status: 'ambiguous' } : { status: 'unique', command });
}

function createMalformedStringCommand(name: string): ModelCommandDefinition {
  return {
    name,
    customFields: new Map(),
    withFile: false,
    issues: ['command metadata must be an object']
  };
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readOptionalMetadataString(
  record: Record<string, unknown>,
  key: 'type' | 'typeName' | 'path',
  fieldName: string,
  issues: string[]
): string | undefined {
  if (!hasOwn(record, key)) {
    return undefined;
  }
  const raw = record[key];
  if (typeof raw !== 'string' || !raw.trim()) {
    issues.push(`custom_fields ${JSON.stringify(fieldName)} ${key} must be a non-empty string when provided`);
    return undefined;
  }
  return raw.trim();
}

function modelCommandValueKind(rawType: string): ModelCommandValueKind {
  switch (rawType.trim().toLowerCase()) {
    case 'string':
    case 'text':
    case 'password':
    case 'date':
    case 'datetime':
    case 'date-time':
      return 'string';
    case 'number':
      return 'number';
    case 'integer':
      return 'integer';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
    case 'json':
      return 'object';
    default:
      return 'unsupported';
  }
}

function isOptionCardinalityMetadata(key: 'type' | 'typeName', rawType: string): boolean {
  const normalized = rawType.trim().toLowerCase();
  return key === 'type'
    ? normalized === 'select' || normalized === 'multiselect'
    : normalized === 'staticlistsingle' ||
        normalized === 'staticlistmulti' ||
        normalized === 'dynamiclistsingle' ||
        normalized === 'dynamiclistmulti';
}

function declaredValueTypeFromMetadata(args: {
  fieldName: string;
  key: 'type' | 'typeName';
  rawType: string | undefined;
  issues: string[];
}): DeclaredModelCommandValueType | undefined {
  if (!args.rawType || isOptionCardinalityMetadata(args.key, args.rawType)) {
    return undefined;
  }
  const kind = modelCommandValueKind(args.rawType);
  if (kind === 'unsupported') {
    args.issues.push(
      `custom_fields ${JSON.stringify(args.fieldName)} declares unsupported ${args.key} ${JSON.stringify(args.rawType)}`
    );
    return undefined;
  }
  return { raw: args.rawType, kind };
}

function extractDeclaredValueType(args: {
  fieldName: string;
  fieldType?: string;
  fieldTypeName?: string;
  optionSet?: ModelCommandOptionSet;
  issues: string[];
}): DeclaredModelCommandValueType | undefined {
  const fieldType = declaredValueTypeFromMetadata({
    fieldName: args.fieldName,
    key: 'type',
    rawType: args.fieldType,
    issues: args.issues
  });
  const fieldTypeName = declaredValueTypeFromMetadata({
    fieldName: args.fieldName,
    key: 'typeName',
    rawType: args.fieldTypeName,
    issues: args.issues
  });
  if (fieldType && fieldTypeName && fieldType.kind !== fieldTypeName.kind) {
    args.issues.push(
      `custom_fields ${JSON.stringify(args.fieldName)} type and typeName declare conflicting value types`
    );
  }

  const declaredType = fieldType ?? fieldTypeName;
  if (!declaredType || !args.optionSet || args.optionSet.cardinality === 'unknown') {
    return declaredType;
  }
  const compatible =
    args.optionSet.cardinality === 'multiple'
      ? declaredType.kind === 'array'
      : declaredType.kind !== 'array' && declaredType.kind !== 'object';
  if (!compatible) {
    args.issues.push(
      `custom_fields ${JSON.stringify(args.fieldName)} declared type ${JSON.stringify(declaredType.raw)} is incompatible with ${args.optionSet.cardinality}-value options`
    );
  }
  return declaredType;
}

function extractModelCommandCandidates(data: unknown): ModelCommandCandidates {
  const rows = isRecord(data) && Array.isArray(data.commands) ? data.commands : [];
  const byName = new Map<string, CommandSelectorEntry>();
  const byFriendlyName = new Map<string, CommandSelectorEntry>();

  for (const row of rows) {
    if (typeof row === 'string' && row.trim()) {
      const name = row.trim();
      addCommandSelector(byName, name, createMalformedStringCommand(name));
      continue;
    }
    if (!isRecord(row)) {
      continue;
    }

    const customFields = new Map<string, ModelCommandCustomFieldDefinition>();
    const issues: string[] = [];
    if (Array.isArray(row.custom_fields)) {
      for (const [index, field] of row.custom_fields.entries()) {
        if (!isRecord(field) || typeof field.name !== 'string' || !field.name.trim()) {
          issues.push(`custom_fields entry ${index + 1} is invalid`);
          continue;
        }
        const fieldName = field.name.trim();
        if (customFields.has(fieldName)) {
          issues.push(`custom_fields contains duplicate name ${JSON.stringify(fieldName)}`);
          continue;
        }
        if (field.required !== undefined && typeof field.required !== 'boolean') {
          issues.push(`custom_fields ${JSON.stringify(fieldName)} required flag must be a boolean`);
        }
        const fieldType = readOptionalMetadataString(field, 'type', fieldName, issues);
        const fieldTypeName = readOptionalMetadataString(field, 'typeName', fieldName, issues);
        readOptionalMetadataString(field, 'path', fieldName, issues);
        const optionSet = extractModelCommandOptionSet(field);
        const declaredType = extractDeclaredValueType({
          fieldName,
          fieldType,
          fieldTypeName,
          ...(optionSet ? { optionSet } : {}),
          issues
        });
        customFields.set(fieldName, {
          required: field.required === true,
          ...(optionSet ? { optionSet } : {}),
          ...(declaredType ? { declaredType } : {})
        });
      }
    } else if (row.custom_fields !== undefined && row.custom_fields !== null) {
      issues.push('custom_fields must be an array');
    }
    if (row.with_file !== undefined && row.with_file !== null && typeof row.with_file !== 'boolean') {
      issues.push('with_file must be a boolean');
    }

    const definition: ModelCommandDefinition = {
      customFields,
      withFile: row.with_file === true,
      issues
    };
    if (typeof row.name === 'string' && row.name.trim()) {
      definition.name = row.name.trim();
      addCommandSelector(byName, definition.name, definition);
    } else {
      issues.push('name must be a non-empty string');
    }
    if (hasOwn(row, 'friendly_name')) {
      if (typeof row.friendly_name === 'string' && row.friendly_name.trim()) {
        definition.friendlyName = row.friendly_name.trim();
        addCommandSelector(byFriendlyName, definition.friendlyName, definition);
      } else {
        issues.push('friendly_name must be a non-empty string when provided');
      }
    }
  }

  return { byName, byFriendlyName };
}

export function extractDeviceModelIdFromResponse(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  if (isRecord(data.model) && typeof data.model.id === 'string' && data.model.id.trim()) {
    return data.model.id.trim();
  }
  if (typeof data.device_model_id === 'string' && data.device_model_id.trim()) {
    return data.device_model_id.trim();
  }
  if (typeof data.model_id === 'string' && data.model_id.trim()) {
    return data.model_id.trim();
  }
  return undefined;
}

function findPriorDeviceModelId(taskOutputs: ReadonlyMap<string, unknown>, deviceId: string): string | undefined {
  for (const output of taskOutputs.values()) {
    if (!isRecord(output) || output.endpointKey !== 'organization.devices.getDevice') {
      continue;
    }
    const request = output.request;
    if (!isRecord(request) || !isRecord(request.path) || String(request.path.device_id ?? '') !== deviceId) {
      continue;
    }
    const response = output.response;
    if (!isRecord(response)) {
      continue;
    }
    const modelId = extractDeviceModelIdFromResponse(response.data);
    if (modelId) {
      return modelId;
    }
  }
  return undefined;
}

function findPriorModelCommandEvidence(
  taskOutputs: ReadonlyMap<string, unknown>,
  modelId: string
): DeviceCommandModelEvidence | undefined {
  for (const output of taskOutputs.values()) {
    if (!isRecord(output) || output.endpointKey !== 'organization.models.getModel') {
      continue;
    }
    const request = output.request;
    if (!isRecord(request) || !isRecord(request.path) || String(request.path.id ?? '') !== modelId) {
      continue;
    }
    const response = output.response;
    if (!isRecord(response)) {
      continue;
    }
    return { modelId, modelData: response.data };
  }
  return undefined;
}

function parseCommandExtraParams(context: Record<string, string>): Record<string, unknown> | undefined {
  const raw = context.command_extra_params_json;
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch {
    // Report the same input error for malformed JSON and valid non-object JSON.
  }
  throw new DeviceCommandNeedsInputError('command_extra_params_json must be a valid JSON object.');
}

function addCommandContextToBody(bodyPayload: unknown, context: Record<string, string>): unknown {
  if (!isRecord(bodyPayload)) {
    return bodyPayload;
  }
  const out: Record<string, unknown> = { ...bodyPayload };
  const extraParams = parseCommandExtraParams(context);
  if (extraParams) {
    out.extra_params = extraParams;
  }
  const fileId = context.command_file_id;
  if (fileId?.trim()) {
    out.file_id = fileId.trim();
  }
  return out;
}

function validateCommandOptionMetadata(modelId: string, command: ModelCommandDefinition): void {
  for (const [fieldName, field] of command.customFields) {
    const optionSet = field.optionSet;
    if (!optionSet || (optionSet.issues.length === 0 && optionSet.options.length > 0)) {
      continue;
    }
    if (optionSet.issues.includes(MODEL_COMMAND_PATH_OPTIONS_ISSUE)) {
      throw new DeviceCommandNeedsInputError(
        `Selected command for model ${modelId} uses path-backed options for extra_params field ${fieldName}; those choices cannot be resolved from model metadata.`
      );
    }
    throw new DeviceCommandNeedsInputError(
      `Selected command for model ${modelId} has invalid or ambiguous options metadata for extra_params field ${fieldName}.`
    );
  }
}

function validateDeclaredCommandValue(
  modelId: string,
  fieldName: string,
  declaredType: DeclaredModelCommandValueType,
  value: unknown
): void {
  if (declaredType.kind === 'unsupported') {
    throw new DeviceCommandNeedsInputError(
      `Selected command for model ${modelId} declares unsupported type ${JSON.stringify(declaredType.raw)} for extra_params field ${fieldName}.`
    );
  }
  const valid =
    declaredType.kind === 'string'
      ? typeof value === 'string'
      : declaredType.kind === 'number'
        ? typeof value === 'number' && Number.isFinite(value)
        : declaredType.kind === 'integer'
          ? typeof value === 'number' && Number.isInteger(value)
          : declaredType.kind === 'boolean'
            ? typeof value === 'boolean'
            : declaredType.kind === 'array'
              ? Array.isArray(value)
              : isRecord(value);
  if (!valid) {
    throw new DeviceCommandNeedsInputError(
      `Selected command for model ${modelId} requires extra_params field ${fieldName} to match declared type ${JSON.stringify(declaredType.raw)}.`
    );
  }
}

function validateCommandArguments(
  modelId: string,
  command: ModelCommandDefinition,
  bodyPayload: Record<string, unknown>
): Record<string, unknown> {
  if (command.issues.length > 0) {
    throw new DeviceCommandNeedsInputError(
      `Selected command for model ${modelId} has invalid or ambiguous metadata: ${command.issues.join('; ')}.`
    );
  }
  validateCommandOptionMetadata(modelId, command);
  const extraParams = isRecord(bodyPayload.extra_params) ? bodyPayload.extra_params : {};
  const extraKeys = Object.keys(extraParams);
  if (extraKeys.length > 0 && command.customFields.size === 0) {
    throw new DeviceCommandNeedsInputError(
      `Selected command for model ${modelId} does not define custom_fields, but extra_params were provided.`
    );
  }
  const unknownKeys = extraKeys.filter((key) => !command.customFields.has(key));
  if (unknownKeys.length > 0) {
    throw new DeviceCommandNeedsInputError(
      `Selected command for model ${modelId} does not define extra_params field(s): ${unknownKeys.join(', ')}.`
    );
  }
  const missingRequired = [...command.customFields.entries()]
    .filter(([, field]) => field.required)
    .map(([name]) => name)
    .filter((key) => {
      const value = extraParams[key];
      const field = command.customFields.get(key);
      return (
        value === undefined ||
        value === null ||
        value === '' ||
        (field?.optionSet?.cardinality === 'multiple' && Array.isArray(value) && value.length === 0)
      );
    });
  if (missingRequired.length > 0) {
    throw new DeviceCommandNeedsInputError(
      `Selected command for model ${modelId} requires extra_params field(s): ${missingRequired.join(', ')}.`
    );
  }
  if (command.withFile && (typeof bodyPayload.file_id !== 'string' || !bodyPayload.file_id.trim())) {
    throw new DeviceCommandNeedsInputError(`Selected command for model ${modelId} requires command_file_id.`);
  }

  const normalizedExtraParams: Record<string, unknown> = { ...extraParams };
  for (const key of extraKeys) {
    const field = command.customFields.get(key);
    const optionSet = field?.optionSet;
    if (!optionSet) {
      if (field?.declaredType) {
        validateDeclaredCommandValue(modelId, key, field.declaredType, extraParams[key]);
      }
      continue;
    }
    const match = matchModelCommandOption(optionSet, extraParams[key]);
    if (match.status !== 'matched') {
      const problem =
        match.status === 'ambiguous'
          ? 'an ambiguous value'
          : match.status === 'invalid-cardinality'
            ? 'a value with the wrong scalar/array shape'
            : 'an unknown value';
      throw new DeviceCommandNeedsInputError(
        `Selected command for model ${modelId} has ${problem} for extra_params field ${key}.`
      );
    }
    if (field?.declaredType) {
      validateDeclaredCommandValue(modelId, key, field.declaredType, match.value);
    }
    normalizedExtraParams[key] = match.value;
  }

  return extraKeys.length > 0 ? { ...bodyPayload, extra_params: normalizedExtraParams } : bodyPayload;
}

function assertValidSendCommandRequestBody(
  bodyPayload: unknown,
  sourceLabel: string
): asserts bodyPayload is Record<string, unknown> {
  if (!isRecord(bodyPayload)) {
    throw new DeviceCommandNeedsInputError(
      `${sourceLabel} requires body.command or body.friendly_name selected from organization.models.getModel commands[].`
    );
  }
  const bodyInspection = inspectSendCommandRequestBody(bodyPayload);
  if (bodyInspection?.hasParams) {
    throw new DeviceCommandNeedsInputError(
      `${sourceLabel} must use body.extra_params for command request values; body.params is response-only data.`
    );
  }
  if (bodyInspection?.hasInvalidExtraParams) {
    throw new DeviceCommandNeedsInputError(`${sourceLabel} requires body.extra_params to be a JSON object.`);
  }
  if (bodyInspection?.hasName) {
    throw new DeviceCommandNeedsInputError(
      `${sourceLabel} must use body.command or body.friendly_name for ${SEND_COMMAND_ENDPOINT}; body.name is not supported.`
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(bodyPayload, 'command') &&
    (typeof bodyPayload.command !== 'string' || !bodyPayload.command.trim())
  ) {
    throw new DeviceCommandNeedsInputError(
      `${sourceLabel} requires body.command to be a non-empty string when provided.`
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(bodyPayload, 'friendly_name') &&
    (typeof bodyPayload.friendly_name !== 'string' || !bodyPayload.friendly_name.trim())
  ) {
    throw new DeviceCommandNeedsInputError(
      `${sourceLabel} requires body.friendly_name to be a non-empty string when provided.`
    );
  }
  const commandName = typeof bodyPayload.command === 'string' ? bodyPayload.command.trim() : '';
  const friendlyName = typeof bodyPayload.friendly_name === 'string' ? bodyPayload.friendly_name.trim() : '';
  if (!commandName && !friendlyName) {
    throw new DeviceCommandNeedsInputError(
      `${sourceLabel} requires body.command or body.friendly_name selected from organization.models.getModel commands[].`
    );
  }
}

export function prepareModelBackedDeviceCommandBody(args: {
  evidence: DeviceCommandModelEvidence;
  bodyPayload: unknown;
  sourceLabel?: string;
}): Record<string, unknown> {
  const sourceLabel = args.sourceLabel ?? 'Command send';
  const { bodyPayload } = args;
  assertValidSendCommandRequestBody(bodyPayload, sourceLabel);

  const modelId = args.evidence?.modelId?.trim();
  if (!modelId) {
    throw new DeviceCommandNeedsInputError(`${sourceLabel} requires device model evidence before sending a command.`);
  }
  const commandName = typeof bodyPayload.command === 'string' ? bodyPayload.command.trim() : '';
  const friendlyName = typeof bodyPayload.friendly_name === 'string' ? bodyPayload.friendly_name.trim() : '';

  const candidates = extractModelCommandCandidates(args.evidence.modelData);
  if (candidates.byName.size === 0 && candidates.byFriendlyName.size === 0) {
    throw new DeviceCommandNeedsInputError(
      `${sourceLabel} requires supported-command evidence from organization.models.getModel for model ${modelId}.`
    );
  }

  const commandDefinition = commandName
    ? resolveCommandSelector(candidates.byName, commandName, 'command name', modelId)
    : undefined;
  const friendlyNameDefinition = friendlyName
    ? resolveCommandSelector(candidates.byFriendlyName, friendlyName, 'friendly_name', modelId)
    : undefined;
  if (commandDefinition && friendlyNameDefinition && commandDefinition !== friendlyNameDefinition) {
    throw new DeviceCommandNeedsInputError(
      `Selected command name ${JSON.stringify(commandName)} and friendly_name ${JSON.stringify(friendlyName)} identify different model commands for model ${modelId}.`
    );
  }

  const selectedDefinition = commandDefinition ?? friendlyNameDefinition;
  if (!selectedDefinition) {
    throw new DeviceCommandNeedsInputError(
      `${sourceLabel} requires body.command or body.friendly_name selected from organization.models.getModel commands[].`
    );
  }

  const normalizedBodyPayload: Record<string, unknown> = {
    ...bodyPayload,
    ...(commandName ? { command: commandName } : {}),
    ...(friendlyName ? { friendly_name: friendlyName } : {})
  };
  return validateCommandArguments(modelId, selectedDefinition, normalizedBodyPayload);
}

function resolveCommandSelector(
  index: ReadonlyMap<string, CommandSelectorEntry>,
  selector: string,
  selectorLabel: 'command name' | 'friendly_name',
  modelId: string
): ModelCommandDefinition {
  const entry = index.get(selector);
  if (!entry) {
    const sourceField = selectorLabel === 'command name' ? 'commands[].name' : 'commands[].friendly_name';
    throw new DeviceCommandNeedsInputError(
      `Selected ${selectorLabel} ${JSON.stringify(selector)} was not found in organization.models.getModel ${sourceField} for model ${modelId}.`
    );
  }
  if (entry.status === 'ambiguous') {
    throw new DeviceCommandNeedsInputError(
      `Selected ${selectorLabel} ${JSON.stringify(selector)} is ambiguous in organization.models.getModel commands[] for model ${modelId}.`
    );
  }
  return entry.command;
}

function validateSendCommandAgainstModel(args: {
  stepId: string;
  context: Record<string, string>;
  taskOutputs: ReadonlyMap<string, unknown>;
  pathPayload: unknown;
  bodyPayload: unknown;
}): unknown {
  const { stepId, context, taskOutputs, pathPayload, bodyPayload } = args;
  if (!isRecord(pathPayload)) {
    throw new DeviceCommandNeedsInputError(
      `Step ${stepId} requires path.device_id before sending ${SEND_COMMAND_ENDPOINT}.`
    );
  }
  assertValidSendCommandRequestBody(bodyPayload, `Step ${stepId}`);
  const deviceId = String(pathPayload.device_id ?? '');
  if (!deviceId) {
    throw new DeviceCommandNeedsInputError(
      `Step ${stepId} requires device_id before sending ${SEND_COMMAND_ENDPOINT}.`
    );
  }

  const modelId = findPriorDeviceModelId(taskOutputs, deviceId) ?? context.device_model_id;
  if (!modelId) {
    throw new DeviceCommandNeedsInputError(
      `Step ${stepId} requires device model evidence from organization.devices.getDevice before sending a command.`
    );
  }

  const evidence = findPriorModelCommandEvidence(taskOutputs, modelId);
  if (!evidence) {
    throw new DeviceCommandNeedsInputError(
      `Step ${stepId} requires supported-command evidence from organization.models.getModel for model ${modelId}.`
    );
  }
  return prepareModelBackedDeviceCommandBody({
    evidence,
    bodyPayload,
    sourceLabel: `Step ${stepId}`
  });
}

export function prepareDeviceCommandBody(args: {
  endpointKey: string;
  stepId: string;
  context: Record<string, string>;
  taskOutputs: ReadonlyMap<string, unknown>;
  pathPayload: unknown;
  bodyPayload: unknown;
}): unknown {
  if (args.endpointKey !== SEND_COMMAND_ENDPOINT) {
    return args.bodyPayload;
  }
  return validateSendCommandAgainstModel({
    ...args,
    bodyPayload: addCommandContextToBody(args.bodyPayload, args.context)
  });
}

function parseCommandPollEnabled(raw: string | undefined, key: string): boolean {
  if (raw === undefined || !raw.trim() || raw.trim().toLowerCase() === 'false') return false;
  if (raw.trim().toLowerCase() === 'true') return true;
  throw new DeviceCommandNeedsInputError(`${key} must be true or false.`);
}

function parseCommandPollPositiveInt(raw: string | undefined, key: string): number | undefined {
  let value: number | undefined;
  try {
    value = parseEdgePollPositiveInt(raw, key);
  } catch {
    throw new DeviceCommandNeedsInputError(`${key} must be a positive integer.`);
  }
  if (value !== undefined && value > MAX_COMMAND_POLL_DELAY_MS) {
    throw new DeviceCommandNeedsInputError(`${key} must be no greater than ${MAX_COMMAND_POLL_DELAY_MS}.`);
  }
  return value;
}

function resolveCommandPollConfiguration(
  config: NonNullable<FlowTaskStep['commandPoll']>,
  context: Record<string, string>
): { enabled: false } | { enabled: true; timeoutMs: number; intervalMs?: number } {
  if (!parseCommandPollEnabled(context[config.enabledKey], config.enabledKey)) {
    return { enabled: false };
  }
  const timeoutMs = parseCommandPollPositiveInt(context[config.timeoutMsKey], config.timeoutMsKey);
  if (timeoutMs === undefined) {
    throw new DeviceCommandNeedsInputError(`${config.timeoutMsKey} is required when ${config.enabledKey}=true.`);
  }
  const intervalMs = parseCommandPollPositiveInt(context[config.intervalMsKey], config.intervalMsKey);
  return {
    enabled: true,
    timeoutMs,
    ...(intervalMs === undefined ? {} : { intervalMs })
  };
}

export function validateDependentCommandPoll(args: {
  steps: readonly FlowStep[];
  sendStepId: string;
  context: Record<string, string>;
}): void {
  for (const candidate of args.steps) {
    if (
      candidate.kind === 'task' &&
      candidate.task === 'command.poll' &&
      candidate.commandPoll?.sendStepId === args.sendStepId
    ) {
      resolveCommandPollConfiguration(candidate.commandPoll, args.context);
    }
  }
}

export async function runDeviceCommandPollStep(args: {
  stepId: string;
  config: NonNullable<FlowTaskStep['commandPoll']>;
  context: Record<string, string>;
  sendOutput: unknown;
  client: XyteClient;
  tenantId: string;
}): Promise<DeviceCommandPollStepResult> {
  const options = resolveCommandPollConfiguration(args.config, args.context);
  if (!options.enabled) {
    return { ok: true, output: { outcome: 'not_requested' } };
  }

  const sendRequest =
    isRecord(args.sendOutput) && isRecord(args.sendOutput.request) ? args.sendOutput.request : undefined;
  const sendPath = sendRequest && isRecord(sendRequest.path) ? sendRequest.path : undefined;
  const deviceId = sendPath?.device_id;
  if (typeof deviceId !== 'string' || !deviceId.trim()) {
    throw new DeviceCommandNeedsInputError(
      `Step ${args.stepId} requires an exact non-empty device_id in ${args.config.sendStepId} request.path.`
    );
  }
  if (args.context.device_id !== deviceId) {
    throw new DeviceCommandNeedsInputError(
      `Step ${args.stepId} requires context device_id to exactly match ${args.config.sendStepId} request.path.device_id.`
    );
  }

  const sendResponse =
    isRecord(args.sendOutput) && isRecord(args.sendOutput.response) ? args.sendOutput.response.data : undefined;
  const commandId = extractSentCommandId(sendResponse);
  if (!commandId) {
    return {
      ok: false,
      failureDetail: `Step ${args.stepId} could not read a command id from ${args.config.sendStepId}.`
    };
  }

  const result = await pollCommandStatus({
    client: args.client,
    tenantId: args.tenantId,
    deviceId,
    commandId,
    timeoutMs: options.timeoutMs,
    ...(options.intervalMs === undefined ? {} : { intervalMs: options.intervalMs })
  });
  if (result.outcome === 'done') {
    return { ok: true, output: result };
  }
  const statusDetail = result.lastStatus ? ` Last status: ${result.lastStatus}.` : '';
  return {
    ok: false,
    failureDetail:
      result.outcome === 'timeout'
        ? `Command ${commandId} status polling timed out.${statusDetail}`
        : `Command ${commandId} ended with status ${result.outcome}.`,
    output: result
  };
}
