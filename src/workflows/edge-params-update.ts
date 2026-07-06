import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

import { toProblemDetails } from '../client/errors';
import { CliUserError } from '../contracts/user-error';
import type { XyteClient } from '../types/client';
import { ensureParentDir } from '../utils/fs';
import { errorMessage } from '../utils/error-format';
import { isRecord } from '../utils/json';
import { loadInputRows, type UtilityInputFormat } from '../utils/input-parser';

const MASKED_PASSWORD_VALUE = '*****';
const EDGE_PARAMS_DISPOSITIONS = new Set<EdgeParamsDisposition>([
  'planned',
  'succeeded',
  'failed',
  'rejected',
  'skipped'
]);

export type EdgeParamsDisposition = 'planned' | 'succeeded' | 'failed' | 'rejected' | 'skipped';

export interface EdgeModelParameter {
  name: string;
  type?: string;
  required?: boolean;
}

export interface EdgeParamsPlan {
  device_id: string;
  model_id: string;
  model_name?: string;
  set: Record<string, unknown>;
  current_custom_parameters: Record<string, unknown>;
  merged_custom_parameters: Record<string, unknown>;
  requestBody: {
    custom_parameters: Record<string, unknown>;
  };
  supportedParameters: EdgeModelParameter[];
}

export interface EdgeParamsOutcome {
  rowIndex?: number;
  device_id: string;
  disposition: EdgeParamsDisposition;
  detail?: string;
  rejectReason?: string;
  plan?: EdgeParamsPlan;
  response?: unknown;
  verification?: {
    ok: boolean;
    mismatches: Array<{ key: string; expected: unknown; actual: unknown }>;
  };
}

export interface EdgeParamsUpdateResult {
  schemaVersion: 'xyte.edge.params-update.v1';
  generatedAtUtc: string;
  tenantId: string;
  mode: 'plan' | 'apply';
  outcome: EdgeParamsOutcome;
}

export interface EdgeParamsBatchTotals {
  rows: number;
  planned: number;
  succeeded: number;
  failed: number;
  rejected: number;
  skipped: number;
}

export interface EdgeParamsBatchResult {
  schemaVersion: 'xyte.edge.params-update-batch.v1';
  generatedAtUtc: string;
  tenantId: string;
  mode: 'plan' | 'apply';
  runId: string;
  reportPath?: string;
  resumePath?: string;
  totals: EdgeParamsBatchTotals;
  rows: EdgeParamsOutcome[];
}

interface BuildPlanArgs {
  client: XyteClient;
  tenantId: string;
  deviceId: string;
  set: Record<string, unknown>;
  expectedModelId?: string;
}

export interface RunEdgeParamsUpdateArgs extends BuildPlanArgs {
  apply: boolean;
}

export interface RunEdgeParamsUpdateBatchArgs {
  client: XyteClient;
  tenantId: string;
  inputPath: string;
  inputFormat?: UtilityInputFormat;
  apply: boolean;
  reportPath?: string;
  resumePath?: string;
  runId?: string;
}

interface ResumeEntry {
  rowIndex: number;
  device_id: string;
  disposition: EdgeParamsDisposition;
}

function resumeKey(rowIndex: number, deviceId: string): string {
  return `${rowIndex}:${deviceId}`;
}

function parseSetJson(value: unknown): { value?: Record<string, unknown>; error?: string } {
  if (value === undefined || value === null || value === '') {
    return { error: 'set_json is required.' };
  }
  if (isRecord(value)) {
    return { value };
  }
  const raw = String(value).trim();
  if (!raw) {
    return { error: 'set_json is required.' };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed)) {
      return { value: parsed };
    }
    return { error: 'set_json must be a JSON object.' };
  } catch {
    return { error: 'set_json must be valid JSON.' };
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function extractCustomParameters(device: unknown): Record<string, unknown> {
  if (!isRecord(device)) return {};
  if (isRecord(device.custom_parameters)) {
    return { ...device.custom_parameters };
  }
  if (isRecord(device.details) && isRecord(device.details.custom_parameters)) {
    return { ...device.details.custom_parameters };
  }
  return {};
}

function extractDeviceModelId(device: unknown): string | undefined {
  if (!isRecord(device)) return undefined;
  if (isRecord(device.model) && typeof device.model.id === 'string' && device.model.id.trim()) {
    return device.model.id.trim();
  }
  if (typeof device.device_model_id === 'string' && device.device_model_id.trim()) {
    return device.device_model_id.trim();
  }
  if (typeof device.model_id === 'string' && device.model_id.trim()) {
    return device.model_id.trim();
  }
  return undefined;
}

function extractModelName(model: unknown): string | undefined {
  if (!isRecord(model)) return undefined;
  const vendor = typeof model.vendor === 'string' ? model.vendor.trim() : '';
  const name = typeof model.model === 'string' ? model.model.trim() : '';
  return [vendor, name].filter(Boolean).join(' ') || undefined;
}

function extractModelParameters(model: unknown): EdgeModelParameter[] {
  if (!isRecord(model) || !Array.isArray(model.parameters)) {
    return [];
  }
  const parameters: EdgeModelParameter[] = [];
  for (const item of model.parameters) {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) {
      continue;
    }
    parameters.push({
      name: item.name.trim(),
      ...(typeof item.type === 'string' && item.type.trim() ? { type: item.type.trim() } : {}),
      ...(typeof item.required === 'boolean' ? { required: item.required } : {})
    });
  }
  return parameters;
}

function reject(deviceId: string, detail: string, rejectReason: string, rowIndex?: number): EdgeParamsOutcome {
  return {
    ...(rowIndex !== undefined ? { rowIndex } : {}),
    device_id: deviceId,
    disposition: 'rejected',
    detail,
    rejectReason
  };
}

function isMissingRequiredParameter(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

async function buildEdgeParamsPlan(args: BuildPlanArgs): Promise<EdgeParamsPlan | EdgeParamsOutcome> {
  let device: unknown;
  try {
    const deviceResponse = await args.client.callWithMeta('organization.devices.getDevice', {
      tenantId: args.tenantId,
      path: { device_id: args.deviceId }
    });
    device = deviceResponse.data;
  } catch (error) {
    const problem = toProblemDetails(error);
    return {
      device_id: args.deviceId,
      disposition: 'failed',
      detail: problem.detail || errorMessage(error)
    };
  }

  const modelId = extractDeviceModelId(device);
  if (!modelId) {
    return reject(args.deviceId, 'Device response does not include a model id.', 'missing_model_id');
  }
  if (args.expectedModelId?.trim() && args.expectedModelId.trim() !== modelId) {
    return reject(
      args.deviceId,
      `Device model ${modelId} does not match expected model ${args.expectedModelId.trim()}.`,
      'model_mismatch'
    );
  }

  let model: unknown;
  try {
    const modelResponse = await args.client.callWithMeta('organization.models.getModel', {
      tenantId: args.tenantId,
      path: { id: modelId }
    });
    model = modelResponse.data;
  } catch (error) {
    const problem = toProblemDetails(error);
    return {
      device_id: args.deviceId,
      disposition: 'failed',
      detail: problem.detail || errorMessage(error)
    };
  }

  const parameters = extractModelParameters(model);
  const supportedNames = new Set(parameters.map((parameter) => parameter.name));
  const unknownKeys = Object.keys(args.set).filter((key) => !supportedNames.has(key));
  if (unknownKeys.length > 0) {
    return reject(
      args.deviceId,
      `Unsupported custom parameter(s) for model ${modelId}: ${unknownKeys.join(', ')}.`,
      'unknown_parameter'
    );
  }

  const current = extractCustomParameters(device);
  const unsupportedCurrentKeys = Object.keys(current).filter((key) => !supportedNames.has(key));
  if (unsupportedCurrentKeys.length > 0) {
    return reject(
      args.deviceId,
      `Current device custom_parameters contain unsupported key(s) for model ${modelId}: ${unsupportedCurrentKeys.join(', ')}. Refusing to preserve unknown keys in a full replacement write.`,
      'unsupported_current_parameter'
    );
  }

  const merged = { ...current, ...args.set };
  const missingRequired = parameters
    .filter((parameter) => parameter.required && isMissingRequiredParameter(merged[parameter.name]))
    .map((parameter) => parameter.name);
  if (missingRequired.length > 0) {
    return reject(
      args.deviceId,
      `Required custom parameter(s) missing for model ${modelId}: ${missingRequired.join(', ')}.`,
      'missing_required_parameter'
    );
  }

  for (const parameter of parameters) {
    if (parameter.type !== 'password') {
      continue;
    }
    const supplied = hasOwn(args.set, parameter.name);
    if (supplied && args.set[parameter.name] === MASKED_PASSWORD_VALUE) {
      return reject(
        args.deviceId,
        `Parameter ${parameter.name} is a password; provide the real replacement value instead of ${MASKED_PASSWORD_VALUE}.`,
        'masked_password_requires_value'
      );
    }
    if (!supplied && current[parameter.name] === MASKED_PASSWORD_VALUE) {
      return reject(
        args.deviceId,
        `Parameter ${parameter.name} is currently masked; provide an explicit replacement before a full custom_parameters write.`,
        'masked_password_requires_value'
      );
    }
  }

  return {
    device_id: args.deviceId,
    model_id: modelId,
    ...(extractModelName(model) ? { model_name: extractModelName(model) } : {}),
    set: args.set,
    current_custom_parameters: current,
    merged_custom_parameters: merged,
    requestBody: { custom_parameters: merged },
    supportedParameters: parameters
  };
}

function verifyCustomParameters(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  parameters: EdgeModelParameter[]
): { ok: boolean; mismatches: Array<{ key: string; expected: unknown; actual: unknown }> } {
  const passwordKeys = new Set(
    parameters.filter((parameter) => parameter.type === 'password').map((parameter) => parameter.name)
  );
  const mismatches: Array<{ key: string; expected: unknown; actual: unknown }> = [];
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];
    if (passwordKeys.has(key) && actualValue === MASKED_PASSWORD_VALUE) {
      continue;
    }
    if (!deepEqual(expectedValue, actualValue)) {
      mismatches.push({ key, expected: expectedValue, actual: actualValue });
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

export async function runEdgeParamsUpdate(args: RunEdgeParamsUpdateArgs): Promise<EdgeParamsUpdateResult> {
  const mode: EdgeParamsUpdateResult['mode'] = args.apply ? 'apply' : 'plan';
  const plan = await buildEdgeParamsPlan(args);
  if ('disposition' in plan) {
    return {
      schemaVersion: 'xyte.edge.params-update.v1',
      generatedAtUtc: new Date().toISOString(),
      tenantId: args.tenantId,
      mode,
      outcome: plan
    };
  }

  if (!args.apply) {
    return {
      schemaVersion: 'xyte.edge.params-update.v1',
      generatedAtUtc: new Date().toISOString(),
      tenantId: args.tenantId,
      mode,
      outcome: {
        device_id: args.deviceId,
        disposition: 'planned',
        detail: 'Plan mode: no updateDevice call was sent.',
        plan
      }
    };
  }

  let updateResponse: unknown;
  try {
    const response = await args.client.callWithMeta('organization.devices.updateDevice', {
      tenantId: args.tenantId,
      path: { device_id: args.deviceId },
      body: plan.requestBody
    });
    updateResponse = response.data;
  } catch (error) {
    const problem = toProblemDetails(error);
    return {
      schemaVersion: 'xyte.edge.params-update.v1',
      generatedAtUtc: new Date().toISOString(),
      tenantId: args.tenantId,
      mode,
      outcome: {
        device_id: args.deviceId,
        disposition: 'failed',
        detail: problem.detail || errorMessage(error),
        plan
      }
    };
  }

  try {
    const readBack = await args.client.callWithMeta('organization.devices.getDevice', {
      tenantId: args.tenantId,
      path: { device_id: args.deviceId }
    });
    const verification = verifyCustomParameters(
      plan.merged_custom_parameters,
      extractCustomParameters(readBack.data),
      plan.supportedParameters
    );
    return {
      schemaVersion: 'xyte.edge.params-update.v1',
      generatedAtUtc: new Date().toISOString(),
      tenantId: args.tenantId,
      mode,
      outcome: {
        device_id: args.deviceId,
        disposition: verification.ok ? 'succeeded' : 'failed',
        detail: verification.ok ? 'Updated and verified custom_parameters.' : 'Read-back verification failed.',
        plan,
        response: updateResponse,
        verification
      }
    };
  } catch (error) {
    const problem = toProblemDetails(error);
    return {
      schemaVersion: 'xyte.edge.params-update.v1',
      generatedAtUtc: new Date().toISOString(),
      tenantId: args.tenantId,
      mode,
      outcome: {
        device_id: args.deviceId,
        disposition: 'failed',
        detail: `Update sent, but read-back verification failed: ${problem.detail || errorMessage(error)}`,
        plan,
        response: updateResponse
      }
    };
  }
}

function outcomeWithRowIndex(outcome: EdgeParamsOutcome, rowIndex: number): EdgeParamsOutcome {
  return { ...outcome, rowIndex };
}

function appendReportLine(reportPath: string | undefined, payload: Record<string, unknown>): void {
  if (!reportPath) return;
  ensureParentDir(reportPath);
  appendFileSync(reportPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function appendResumeEntry(resumePath: string | undefined, entry: ResumeEntry): void {
  if (!resumePath) return;
  ensureParentDir(resumePath);
  appendFileSync(resumePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function loadResumeEntries(resumePath: string | undefined): Map<string, ResumeEntry> {
  const map = new Map<string, ResumeEntry>();
  if (!resumePath || !existsSync(resumePath)) return map;
  const raw = readFileSync(resumePath, 'utf8');
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ResumeEntry;
      if (
        parsed &&
        typeof parsed.rowIndex === 'number' &&
        typeof parsed.device_id === 'string' &&
        EDGE_PARAMS_DISPOSITIONS.has(parsed.disposition)
      ) {
        map.set(resumeKey(parsed.rowIndex, parsed.device_id), parsed);
        continue;
      }
      throw new Error('invalid entry');
    } catch {
      throw new CliUserError({
        summary: `Resume artifact ${resumePath} is malformed at line ${index + 1}.`
      });
    }
  }
  return map;
}

function incrementTotals(totals: EdgeParamsBatchTotals, disposition: EdgeParamsDisposition): void {
  switch (disposition) {
    case 'planned':
      totals.planned += 1;
      break;
    case 'succeeded':
      totals.succeeded += 1;
      break;
    case 'failed':
      totals.failed += 1;
      break;
    case 'rejected':
      totals.rejected += 1;
      break;
    case 'skipped':
      totals.skipped += 1;
      break;
  }
}

export async function runEdgeParamsUpdateBatch(
  args: RunEdgeParamsUpdateBatchArgs
): Promise<EdgeParamsBatchResult> {
  const rows = loadInputRows(args.inputPath, args.inputFormat ?? 'auto').rows;
  const mode: EdgeParamsBatchResult['mode'] = args.apply ? 'apply' : 'plan';
  const runId = args.runId ?? `edge-params-update-${Date.now()}`;
  const totals: EdgeParamsBatchTotals = {
    rows: rows.length,
    planned: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    skipped: 0
  };
  const outcomes: EdgeParamsOutcome[] = [];
  const resumeMap = loadResumeEntries(args.resumePath);
  const isResuming = resumeMap.size > 0 || (!!args.resumePath && existsSync(args.resumePath));
  const seenDeviceIds = new Set<string>();

  if (args.reportPath && !isResuming) {
    ensureParentDir(args.reportPath);
    writeFileSync(args.reportPath, '', 'utf8');
  }

  for (let index = 0; index < rows.length; index += 1) {
    const rowIndex = index + 1;
    const raw = rows[index];
    const deviceId = typeof raw.device_id === 'string' ? raw.device_id.trim() : '';
    if (!deviceId) {
      const outcome = reject('', 'device_id is required.', 'missing_device_id', rowIndex);
      outcomes.push(outcome);
      incrementTotals(totals, outcome.disposition);
      appendReportLine(args.reportPath, { ...outcome, input: raw, runId, mode });
      continue;
    }

    if (seenDeviceIds.has(deviceId)) {
      const outcome = reject(
        deviceId,
        `Duplicate device_id ${deviceId}; each batch may include a claimed Edge device only once.`,
        'duplicate_device_id',
        rowIndex
      );
      outcomes.push(outcome);
      incrementTotals(totals, outcome.disposition);
      appendReportLine(args.reportPath, { ...outcome, input: raw, runId, mode });
      continue;
    }
    seenDeviceIds.add(deviceId);

    const existing = resumeMap.get(resumeKey(rowIndex, deviceId));
    if (existing?.disposition === 'succeeded') {
      const outcome: EdgeParamsOutcome = {
        rowIndex,
        device_id: deviceId,
        disposition: 'skipped',
        detail: 'Already succeeded on prior run; skipped.'
      };
      outcomes.push(outcome);
      incrementTotals(totals, outcome.disposition);
      appendReportLine(args.reportPath, { ...outcome, runId, mode });
      continue;
    }

    const parsedSet = parseSetJson(raw.set_json);
    if (!parsedSet.value) {
      const outcome = reject(deviceId, parsedSet.error ?? 'set_json is invalid.', 'invalid_set_json', rowIndex);
      outcomes.push(outcome);
      incrementTotals(totals, outcome.disposition);
      appendReportLine(args.reportPath, { ...outcome, input: raw, runId, mode });
      continue;
    }

    const expectedModelId =
      typeof raw.expected_model_id === 'string' && raw.expected_model_id.trim()
        ? raw.expected_model_id.trim()
        : undefined;
    const result = await runEdgeParamsUpdate({
      client: args.client,
      tenantId: args.tenantId,
      deviceId,
      set: parsedSet.value,
      expectedModelId,
      apply: args.apply
    });
    const outcome = outcomeWithRowIndex(result.outcome, rowIndex);
    outcomes.push(outcome);
    incrementTotals(totals, outcome.disposition);
    appendReportLine(args.reportPath, { ...outcome, input: raw, runId, mode });
    if (args.apply) {
      appendResumeEntry(args.resumePath, { rowIndex, device_id: deviceId, disposition: outcome.disposition });
      resumeMap.set(resumeKey(rowIndex, deviceId), { rowIndex, device_id: deviceId, disposition: outcome.disposition });
    }
  }

  return {
    schemaVersion: 'xyte.edge.params-update-batch.v1',
    generatedAtUtc: new Date().toISOString(),
    tenantId: args.tenantId,
    mode,
    runId,
    ...(args.reportPath ? { reportPath: args.reportPath } : {}),
    ...(args.resumePath ? { resumePath: args.resumePath } : {}),
    totals,
    rows: outcomes
  };
}

export function edgeParamsBatchExitedClean(result: EdgeParamsBatchResult): boolean {
  return result.totals.failed === 0 && result.totals.rejected === 0;
}

export function parseEdgeParamsSetJson(raw: string | undefined): Record<string, unknown> {
  const parsed = parseSetJson(raw);
  if (!parsed.value) {
    throw new CliUserError({ summary: `Invalid edge custom parameter input: ${parsed.error}` });
  }
  return parsed.value;
}
