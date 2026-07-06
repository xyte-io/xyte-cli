import { isIP } from 'node:net';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

import { ensureParentDir } from '../utils/fs';
import { CliUserError } from '../contracts/user-error';
import { toProblemDetails } from '../client/errors';
import { loadInputRows, type UtilityInputFormat } from '../utils/input-parser';
import type { XyteClient } from '../types/client';
import { errorMessage } from '../utils/error-format';
import {
  EdgeProbeAbortError,
  EdgeProbeRowError,
  pollEdgeStatus,
  type EdgePollOptions,
  type EdgePollResult
} from './edge-poll';
import { runEdgePing, type EdgePingResult } from './edge-ping';

export type EdgeRowDisposition =
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'timeout'
  | 'already-claimed'
  | 'proxy-offline'
  | 'ping-failed'
  | 'skipped'
  | 'aborted';

export interface EdgeClaimRow {
  rowIndex: number;
  proxy_id: string;
  device_ip: string;
  device_model_id: string;
  space_id: number;
  display_name?: string;
  mac?: string;
  sn?: string;
  custom_parameters?: Record<string, unknown>;
  custom_partner_name?: string;
  custom_model_name?: string;
  skip_connectivity_check?: boolean;
}

export interface EdgeClaimModelParameter {
  name: string;
  type?: string;
  required?: boolean;
}

export interface EdgeRowOutcome {
  rowIndex: number;
  proxy_id: string;
  device_ip: string;
  disposition: EdgeRowDisposition;
  attempts: number;
  elapsedMs: number;
  lastState?: string;
  detail?: string;
  rejectReason?: string;
  response?: unknown;
  preClaimPing?: EdgePingResult;
  planned?: EdgeRowPlan;
}

export interface EdgeRowPlan {
  preClaimPing: 'required' | 'skipped';
  claimBody: Record<string, unknown>;
  supportedParameters?: EdgeClaimModelParameter[];
}

export interface EdgeBatchTotals {
  rows: number;
  succeeded: number;
  failed: number;
  rejected: number;
  timeout: number;
  alreadyClaimed: number;
  proxyOffline: number;
  pingFailed: number;
  skipped: number;
  aborted: number;
}

export interface EdgeBatchResult {
  schemaVersion: 'xyte.edge.claim-batch.v1';
  generatedAtUtc: string;
  tenantId: string;
  mode: 'plan' | 'apply';
  runId: string;
  reportPath?: string;
  resumePath?: string;
  totals: EdgeBatchTotals;
  stoppedEarly: boolean;
  abortDetail?: string;
  rows: EdgeRowOutcome[];
}

function parseBooleanLiteral(value: unknown): { value?: boolean; invalid: boolean } {
  if (value === undefined || value === null || value === '') return { invalid: false };
  if (typeof value === 'boolean') return { value, invalid: false };
  const raw = String(value).trim().toLowerCase();
  if (!raw) return { invalid: false };
  if (raw === 'true') return { value: true, invalid: false };
  if (raw === 'false') return { value: false, invalid: false };
  return { invalid: true };
}

function parseIntegerOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const str = String(value).trim();
  if (!str) return undefined;
  const parsed = Number(str);
  if (!Number.isFinite(parsed) || Math.trunc(parsed) !== parsed) return undefined;
  return parsed;
}

function parseCustomParameters(value: unknown): { value?: Record<string, unknown>; error?: string } {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return { value: value as Record<string, unknown> };
  }
  const raw = String(value).trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { value: parsed as Record<string, unknown> };
    }
    return { error: 'custom_parameters must be a JSON object.' };
  } catch {
    return { error: 'custom_parameters must be valid JSON.' };
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function extractModelParameters(model: unknown): EdgeClaimModelParameter[] {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    return [];
  }
  const rec = model as Record<string, unknown>;
  if (!Array.isArray(rec.parameters)) {
    return [];
  }
  const parameters: EdgeClaimModelParameter[] = [];
  for (const item of rec.parameters) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const parameter = item as Record<string, unknown>;
    if (typeof parameter.name !== 'string' || !parameter.name.trim()) {
      continue;
    }
    parameters.push({
      name: parameter.name.trim(),
      ...(typeof parameter.type === 'string' && parameter.type.trim() ? { type: parameter.type.trim() } : {}),
      ...(typeof parameter.required === 'boolean' ? { required: parameter.required } : {})
    });
  }
  return parameters;
}

function isValidHostname(value: string): boolean {
  if (!value || value.length > 253 || value.startsWith('.') || value.endsWith('.') || /^[0-9.]+$/.test(value)) {
    return false;
  }

  const labels = value.split('.');
  return labels.every((label) => {
    if (!label || label.length > 63) {
      return false;
    }
    if (label.startsWith('-') || label.endsWith('-')) {
      return false;
    }
    return /^[A-Za-z0-9-]+$/.test(label);
  });
}

function isValidEdgeDeviceIp(value: string): boolean {
  return isIP(value) !== 0 || isValidHostname(value);
}

export interface EdgeClaimRowValidation {
  ok: true;
  row: EdgeClaimRow;
}

export interface EdgeClaimRowRejection {
  ok: false;
  rowIndex: number;
  reason: string;
  input: Record<string, unknown>;
}

export function validateEdgeClaimRow(
  raw: Record<string, unknown>,
  rowIndex: number
): EdgeClaimRowValidation | EdgeClaimRowRejection {
  const proxyId = typeof raw.proxy_id === 'string' ? raw.proxy_id.trim() : '';
  const deviceIp = typeof raw.device_ip === 'string' ? raw.device_ip.trim() : '';
  const deviceModelId = typeof raw.device_model_id === 'string' ? raw.device_model_id.trim() : '';
  const spaceIdParsed = parseIntegerOrUndefined(raw.space_id);

  if (!proxyId) {
    return { ok: false, rowIndex, reason: 'proxy_id is required.', input: raw };
  }
  if (!deviceIp) {
    return { ok: false, rowIndex, reason: 'device_ip is required.', input: raw };
  }
  if (!isValidEdgeDeviceIp(deviceIp)) {
    return { ok: false, rowIndex, reason: 'device_ip must be a valid IPv4, IPv6, or hostname.', input: raw };
  }
  if (!deviceModelId) {
    return { ok: false, rowIndex, reason: 'device_model_id is required.', input: raw };
  }
  if (spaceIdParsed === undefined || spaceIdParsed <= 0) {
    return { ok: false, rowIndex, reason: 'space_id must be a positive integer.', input: raw };
  }

  const customParams = parseCustomParameters(raw.custom_parameters);
  if (customParams.error) {
    return { ok: false, rowIndex, reason: customParams.error, input: raw };
  }

  const skipConnectivityCheck = parseBooleanLiteral(raw.skip_connectivity_check);
  if (skipConnectivityCheck.invalid) {
    return {
      ok: false,
      rowIndex,
      reason: 'skip_connectivity_check must be the literal true or false.',
      input: raw
    };
  }

  const row: EdgeClaimRow = {
    rowIndex,
    proxy_id: proxyId,
    device_ip: deviceIp,
    device_model_id: deviceModelId,
    space_id: spaceIdParsed
  };
  if (typeof raw.display_name === 'string' && raw.display_name.trim()) {
    row.display_name = raw.display_name.trim();
  }
  if (typeof raw.mac === 'string' && raw.mac.trim()) {
    row.mac = raw.mac.trim();
  }
  if (typeof raw.sn === 'string' && raw.sn.trim()) {
    row.sn = raw.sn.trim();
  }
  if (customParams.value) row.custom_parameters = customParams.value;
  if (typeof raw.custom_partner_name === 'string' && raw.custom_partner_name.trim()) {
    row.custom_partner_name = raw.custom_partner_name.trim();
  }
  if (typeof raw.custom_model_name === 'string' && raw.custom_model_name.trim()) {
    row.custom_model_name = raw.custom_model_name.trim();
  }
  if (skipConnectivityCheck.value !== undefined) row.skip_connectivity_check = skipConnectivityCheck.value;

  return { ok: true, row };
}

export type EdgeClaimModelValidation =
  | { ok: true; parameters: EdgeClaimModelParameter[] }
  | { ok: false; disposition: 'failed' | 'rejected'; detail: string; rejectReason?: string };

type EdgeClaimModelLookup =
  | { ok: true; parameters: EdgeClaimModelParameter[] }
  | { ok: false; disposition: 'failed'; detail: string };

type EdgeClaimModelCache = Map<string, Promise<EdgeClaimModelLookup>>;

async function validateClaimModelParameters(args: {
  client: XyteClient;
  tenantId: string;
  row: EdgeClaimRow;
  cache?: EdgeClaimModelCache;
}): Promise<EdgeClaimModelValidation> {
  const cacheKey = args.row.device_model_id;
  const existing = args.cache?.get(cacheKey);
  let lookupPromise = existing;

  if (!lookupPromise) {
    lookupPromise = (async (): Promise<EdgeClaimModelLookup> => {
      let model: unknown;
      try {
        const response = await args.client.callWithMeta('organization.models.getModel', {
          tenantId: args.tenantId,
          path: { id: args.row.device_model_id }
        });
        model = response.data;
      } catch (error) {
        const problem = toProblemDetails(error);
        return {
          ok: false,
          disposition: 'failed',
          detail: problem.detail || errorMessage(error)
        };
      }

      return { ok: true, parameters: extractModelParameters(model) };
    })();
    args.cache?.set(cacheKey, lookupPromise);
  }

  const lookup = await lookupPromise;
  if (!lookup.ok) {
    return lookup;
  }

  const parameters = lookup.parameters;
  const supportedNames = new Set(parameters.map((parameter) => parameter.name));
  const customParameters = args.row.custom_parameters ?? {};
  const unknownKeys = Object.keys(customParameters).filter((key) => !supportedNames.has(key));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      disposition: 'rejected',
      detail: `Unsupported custom parameter(s) for model ${args.row.device_model_id}: ${unknownKeys.join(', ')}.`,
      rejectReason: 'unknown_custom_parameter'
    };
  }

  const missingRequired = parameters
    .filter(
      (parameter) =>
        parameter.required &&
        (!hasOwn(customParameters, parameter.name) ||
          customParameters[parameter.name] === undefined ||
          customParameters[parameter.name] === null ||
          customParameters[parameter.name] === '')
    )
    .map((parameter) => parameter.name);
  if (missingRequired.length > 0) {
    return {
      ok: false,
      disposition: 'rejected',
      detail: `Required custom parameter(s) missing for model ${args.row.device_model_id}: ${missingRequired.join(', ')}.`,
      rejectReason: 'missing_required_custom_parameter'
    };
  }

  const maskedPasswords = parameters
    .filter(
      (parameter) =>
        parameter.type === 'password' &&
        hasOwn(customParameters, parameter.name) &&
        customParameters[parameter.name] === '*****'
    )
    .map((parameter) => parameter.name);
  if (maskedPasswords.length > 0) {
    return {
      ok: false,
      disposition: 'rejected',
      detail: `Password custom parameter(s) for model ${args.row.device_model_id} cannot use masked value *****: ${maskedPasswords.join(', ')}.`,
      rejectReason: 'masked_password_requires_value'
    };
  }

  return { ok: true, parameters };
}

export async function validateEdgeClaimModelParameters(args: {
  client: XyteClient;
  tenantId: string;
  row: EdgeClaimRow;
}): Promise<EdgeClaimModelValidation> {
  return validateClaimModelParameters(args);
}

function buildClaimBody(row: EdgeClaimRow): Record<string, unknown> {
  const body: Record<string, unknown> = {
    proxy_id: row.proxy_id,
    device_ip: row.device_ip,
    device_model_id: row.device_model_id,
    space_id: row.space_id
  };
  if (row.display_name) body.display_name = row.display_name;
  if (row.mac) body.mac = row.mac;
  if (row.sn) body.sn = row.sn;
  if (row.custom_parameters) body.custom_parameters = row.custom_parameters;
  if (row.custom_partner_name) body.custom_partner_name = row.custom_partner_name;
  if (row.custom_model_name) body.custom_model_name = row.custom_model_name;
  if (row.skip_connectivity_check !== undefined) {
    body.skip_connectivity_check = row.skip_connectivity_check;
  }
  return body;
}

interface ResolvedBatchClaim {
  row: EdgeClaimRow;
  requiresPing: boolean;
  planned: EdgeRowPlan;
}

function resolveBatchClaim(
  row: EdgeClaimRow,
  forceSkipConnectivityCheck: boolean,
  supportedParameters?: EdgeClaimModelParameter[]
): ResolvedBatchClaim | { rejectReason: string } {
  if (forceSkipConnectivityCheck && row.skip_connectivity_check === false) {
    return {
      rejectReason:
        'skip_connectivity_check=false conflicts with --skip-connectivity-check; fix the row or remove the flag.'
    };
  }

  const effectiveRow: EdgeClaimRow =
    forceSkipConnectivityCheck && row.skip_connectivity_check === undefined
      ? { ...row, skip_connectivity_check: true }
      : row;
  const requiresPing = effectiveRow.skip_connectivity_check !== true;
  return {
    row: effectiveRow,
    requiresPing,
    planned: {
      preClaimPing: requiresPing ? 'required' : 'skipped',
      claimBody: buildClaimBody(effectiveRow),
      ...(supportedParameters ? { supportedParameters } : {})
    }
  };
}

function duplicateMatches(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes('already claimed') ||
    normalized.includes('device already') ||
    normalized.includes('already exists')
  );
}

function proxyOfflineMatches(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return (
    normalized.includes('edge offline') ||
    normalized.includes('proxy offline') ||
    normalized.includes('edge unreachable') ||
    normalized.includes('proxy unreachable')
  );
}

function classifyStartClaimDisposition(status: number | undefined): EdgeRowDisposition {
  if (status === 400 || status === 422) {
    return 'rejected';
  }
  return 'failed';
}

export interface RunEdgeClaimArgs {
  client: XyteClient;
  tenantId: string;
  row: EdgeClaimRow;
  modelValidationCache?: EdgeClaimModelCache;
  pollOptions?: EdgePollOptions;
  sleeper?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export async function runEdgeClaim(args: RunEdgeClaimArgs): Promise<EdgeRowOutcome> {
  const startedAt = (args.now ?? Date.now)();
  const modelValidation = await validateClaimModelParameters({
    client: args.client,
    tenantId: args.tenantId,
    row: args.row,
    cache: args.modelValidationCache
  });
  if (!modelValidation.ok) {
    return {
      rowIndex: args.row.rowIndex,
      proxy_id: args.row.proxy_id,
      device_ip: args.row.device_ip,
      disposition: modelValidation.disposition,
      attempts: 0,
      elapsedMs: (args.now ?? Date.now)() - startedAt,
      detail: modelValidation.detail,
      ...(modelValidation.rejectReason ? { rejectReason: modelValidation.rejectReason } : {})
    };
  }

  try {
    await args.client.callWithMeta('organization.edge.startClaim', {
      tenantId: args.tenantId,
      body: buildClaimBody(args.row)
    });
  } catch (error) {
    const problem = toProblemDetails(error);
    if (problem.status === 401) {
      throw new EdgeProbeAbortError('Authorization failed; aborting run.', {
        status: problem.status,
        detail: problem.detail
      });
    }
    const detail = problem.detail || errorMessage(error);
    if (duplicateMatches(detail)) {
      return {
        rowIndex: args.row.rowIndex,
        proxy_id: args.row.proxy_id,
        device_ip: args.row.device_ip,
        disposition: 'already-claimed',
        attempts: 0,
        elapsedMs: (args.now ?? Date.now)() - startedAt,
        detail
      };
    }
    if (proxyOfflineMatches(detail)) {
      return {
        rowIndex: args.row.rowIndex,
        proxy_id: args.row.proxy_id,
        device_ip: args.row.device_ip,
        disposition: 'proxy-offline',
        attempts: 0,
        elapsedMs: (args.now ?? Date.now)() - startedAt,
        detail
      };
    }
    return {
      rowIndex: args.row.rowIndex,
      proxy_id: args.row.proxy_id,
      device_ip: args.row.device_ip,
      disposition: classifyStartClaimDisposition(problem.status),
      attempts: 0,
      elapsedMs: (args.now ?? Date.now)() - startedAt,
      detail
    };
  }

  let poll: EdgePollResult;
  try {
    poll = await pollEdgeStatus({
      client: args.client,
      tenantId: args.tenantId,
      statusEndpointKey: 'organization.edge.getClaimStatus',
      statusResponseFields: ['result', 'status'],
      query: { proxy_id: args.row.proxy_id, device_ip: args.row.device_ip },
      options: args.pollOptions,
      sleeper: args.sleeper,
      now: args.now,
      random: args.random
    });
  } catch (error) {
    if (error instanceof EdgeProbeAbortError) {
      throw error;
    }
    if (error instanceof EdgeProbeRowError) {
      const detail = error.problem.detail;
      return {
        rowIndex: args.row.rowIndex,
        proxy_id: args.row.proxy_id,
        device_ip: args.row.device_ip,
        disposition: proxyOfflineMatches(detail) ? 'proxy-offline' : 'failed',
        attempts: error.progress.attempts,
        elapsedMs: error.progress.elapsedMs,
        lastState: error.progress.lastState,
        detail,
        response: error.progress.lastPayload
      };
    }
    throw error;
  }

  const disposition: EdgeRowDisposition =
    poll.outcome === 'success' ? 'succeeded' : poll.outcome === 'failed' ? 'failed' : 'timeout';
  return {
    rowIndex: args.row.rowIndex,
    proxy_id: args.row.proxy_id,
    device_ip: args.row.device_ip,
    disposition,
    attempts: poll.attempts,
    elapsedMs: poll.elapsedMs,
    lastState: poll.lastState,
    response: poll.lastPayload
  };
}

interface ResumeEntry {
  rowIndex: number;
  proxy_id: string;
  device_ip: string;
  disposition: EdgeRowDisposition;
}

const RESUMABLE_DISPOSITIONS = new Set<EdgeRowDisposition>([
  'succeeded',
  'failed',
  'rejected',
  'timeout',
  'already-claimed',
  'proxy-offline',
  'ping-failed',
  'aborted'
]);

function resumeIdentityKey(proxyId: string, deviceIp: string): string {
  return `${proxyId}\u0000${deviceIp}`;
}

function loadResumeEntries(resumePath: string | undefined): Map<string, ResumeEntry> {
  const map = new Map<string, ResumeEntry>();
  if (!resumePath || !existsSync(resumePath)) return map;
  const raw = readFileSync(resumePath, 'utf8');
  const lines = raw.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lineNumber = index + 1;
    try {
      const parsed = JSON.parse(trimmed) as ResumeEntry;
      if (
        parsed &&
        typeof parsed.rowIndex === 'number' &&
        typeof parsed.proxy_id === 'string' &&
        typeof parsed.device_ip === 'string' &&
        typeof parsed.disposition === 'string'
      ) {
        if (RESUMABLE_DISPOSITIONS.has(parsed.disposition)) {
          map.set(resumeIdentityKey(parsed.proxy_id, parsed.device_ip), parsed);
          continue;
        }
        if (parsed.disposition === 'skipped') {
          continue;
        }
      }
      throw new CliUserError({
        summary: `Resume artifact ${resumePath} is malformed at line ${lineNumber}.`
      });
    } catch (error) {
      if (error instanceof CliUserError) {
        throw error;
      }
      throw new CliUserError({
        summary: `Resume artifact ${resumePath} is malformed at line ${lineNumber}.`
      });
    }
  }
  return map;
}

function appendResumeEntry(resumePath: string | undefined, entry: ResumeEntry): void {
  if (!resumePath) return;
  ensureParentDir(resumePath);
  appendFileSync(resumePath, `${JSON.stringify(entry)}\n`, 'utf8');
}

function appendReportLine(reportPath: string | undefined, payload: Record<string, unknown>): void {
  if (!reportPath) return;
  ensureParentDir(reportPath);
  appendFileSync(reportPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

export interface RunEdgeClaimBatchArgs {
  client: XyteClient;
  tenantId: string;
  inputPath: string;
  inputFormat?: UtilityInputFormat;
  apply: boolean;
  reportPath?: string;
  resumePath?: string;
  runId?: string;
  pollOptions?: EdgePollOptions;
  skipConnectivityCheck?: boolean;
  sleeper?: (ms: number) => Promise<void>;
  now?: () => number;
}

export async function runEdgeClaimBatch(args: RunEdgeClaimBatchArgs): Promise<EdgeBatchResult> {
  const rows = loadInputRows(args.inputPath, args.inputFormat ?? 'auto').rows;
  const runId = args.runId ?? `edge-claim-${Date.now()}`;
  const mode: EdgeBatchResult['mode'] = args.apply ? 'apply' : 'plan';
  const totals: EdgeBatchTotals = {
    rows: rows.length,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    timeout: 0,
    alreadyClaimed: 0,
    proxyOffline: 0,
    pingFailed: 0,
    skipped: 0,
    aborted: 0
  };
  const outcomes: EdgeRowOutcome[] = [];
  let stoppedEarly = false;
  let abortDetail: string | undefined;
  const resumeMap = loadResumeEntries(args.resumePath);
  const isResuming = resumeMap.size > 0 || (!!args.resumePath && existsSync(args.resumePath));
  const modelValidationCache: EdgeClaimModelCache = new Map();

  if (args.reportPath && !isResuming) {
    ensureParentDir(args.reportPath);
    writeFileSync(args.reportPath, '', 'utf8');
  }

  for (let index = 0; index < rows.length; index += 1) {
    const rowIndex = index + 1;
    const raw = rows[index];
    const validation = validateEdgeClaimRow(raw, rowIndex);
    if (!validation.ok) {
      const outcome: EdgeRowOutcome = {
        rowIndex,
        proxy_id: typeof raw.proxy_id === 'string' ? raw.proxy_id : '',
        device_ip: typeof raw.device_ip === 'string' ? raw.device_ip : '',
        disposition: 'rejected',
        attempts: 0,
        elapsedMs: 0,
        rejectReason: validation.reason,
        detail: validation.reason
      };
      outcomes.push(outcome);
      totals.rejected += 1;
      appendReportLine(args.reportPath, { ...outcome, input: raw, runId, mode });
      continue;
    }

    const existing = resumeMap.get(resumeIdentityKey(validation.row.proxy_id, validation.row.device_ip));
    if (existing && (existing.disposition === 'succeeded' || existing.disposition === 'already-claimed')) {
      const outcome: EdgeRowOutcome = {
        rowIndex,
        proxy_id: validation.row.proxy_id,
        device_ip: validation.row.device_ip,
        disposition: 'skipped',
        attempts: 0,
        elapsedMs: 0,
        detail: `Already ${existing.disposition} on prior run; skipped.`
      };
      outcomes.push(outcome);
      totals.skipped += 1;
      appendReportLine(args.reportPath, { ...outcome, runId, mode });
      continue;
    }

    const modelValidation = await validateClaimModelParameters({
      client: args.client,
      tenantId: args.tenantId,
      row: validation.row,
      cache: modelValidationCache
    });
    if (!modelValidation.ok) {
      const outcome: EdgeRowOutcome = {
        rowIndex,
        proxy_id: validation.row.proxy_id,
        device_ip: validation.row.device_ip,
        disposition: modelValidation.disposition,
        attempts: 0,
        elapsedMs: 0,
        detail: modelValidation.detail,
        ...(modelValidation.rejectReason ? { rejectReason: modelValidation.rejectReason } : {})
      };
      outcomes.push(outcome);
      if (modelValidation.disposition === 'rejected') {
        totals.rejected += 1;
      } else {
        totals.failed += 1;
      }
      appendReportLine(args.reportPath, { ...outcome, input: raw, runId, mode });
      continue;
    }

    const resolved = resolveBatchClaim(validation.row, args.skipConnectivityCheck === true, modelValidation.parameters);
    if ('rejectReason' in resolved) {
      const outcome: EdgeRowOutcome = {
        rowIndex,
        proxy_id: validation.row.proxy_id,
        device_ip: validation.row.device_ip,
        disposition: 'rejected',
        attempts: 0,
        elapsedMs: 0,
        rejectReason: resolved.rejectReason,
        detail: resolved.rejectReason
      };
      outcomes.push(outcome);
      totals.rejected += 1;
      appendReportLine(args.reportPath, { ...outcome, input: raw, runId, mode });
      continue;
    }

    if (!args.apply) {
      const outcome: EdgeRowOutcome = {
        rowIndex,
        proxy_id: resolved.row.proxy_id,
        device_ip: resolved.row.device_ip,
        disposition: 'skipped',
        attempts: 0,
        elapsedMs: 0,
        detail: 'Plan mode: skipped actual claim call.',
        planned: resolved.planned
      };
      outcomes.push(outcome);
      totals.skipped += 1;
      appendReportLine(args.reportPath, { ...outcome, runId, mode });
      continue;
    }

    try {
      let preClaimPing: EdgePingResult | undefined;
      if (resolved.requiresPing) {
        preClaimPing = await runEdgePing({
          client: args.client,
          tenantId: args.tenantId,
          proxy_id: resolved.row.proxy_id,
          device_ip: resolved.row.device_ip,
          pollOptions: args.pollOptions,
          sleeper: args.sleeper,
          now: args.now
        });
        if (preClaimPing.disposition !== 'succeeded') {
          const outcome: EdgeRowOutcome = {
            rowIndex,
            proxy_id: resolved.row.proxy_id,
            device_ip: resolved.row.device_ip,
            disposition: 'ping-failed',
            attempts: preClaimPing.attempts,
            elapsedMs: preClaimPing.elapsedMs,
            lastState: preClaimPing.lastState,
            detail: preClaimPing.detail ?? `Pre-claim ping ${preClaimPing.disposition}.`,
            response: preClaimPing.response,
            preClaimPing
          };
          outcomes.push(outcome);
          totals.pingFailed += 1;
          appendReportLine(args.reportPath, { ...outcome, runId, mode });
          appendResumeEntry(args.resumePath, {
            rowIndex,
            proxy_id: resolved.row.proxy_id,
            device_ip: resolved.row.device_ip,
            disposition: outcome.disposition
          });
          resumeMap.set(resumeIdentityKey(resolved.row.proxy_id, resolved.row.device_ip), {
            rowIndex,
            proxy_id: resolved.row.proxy_id,
            device_ip: resolved.row.device_ip,
            disposition: outcome.disposition
          });
          continue;
        }
      }

      const outcome = await runEdgeClaim({
        client: args.client,
        tenantId: args.tenantId,
        row: resolved.row,
        modelValidationCache,
        pollOptions: args.pollOptions,
        sleeper: args.sleeper,
        now: args.now
      });
      if (preClaimPing) {
        outcome.preClaimPing = preClaimPing;
      }
      outcomes.push(outcome);
      switch (outcome.disposition) {
        case 'succeeded':
          totals.succeeded += 1;
          break;
        case 'failed':
          totals.failed += 1;
          break;
        case 'rejected':
          totals.rejected += 1;
          break;
        case 'timeout':
          totals.timeout += 1;
          break;
        case 'already-claimed':
          totals.alreadyClaimed += 1;
          break;
        case 'proxy-offline':
          totals.proxyOffline += 1;
          break;
        case 'ping-failed':
          totals.pingFailed += 1;
          break;
        default:
          break;
      }
      appendReportLine(args.reportPath, { ...outcome, runId, mode });
      appendResumeEntry(args.resumePath, {
        rowIndex,
        proxy_id: resolved.row.proxy_id,
        device_ip: resolved.row.device_ip,
        disposition: outcome.disposition
      });
      resumeMap.set(resumeIdentityKey(resolved.row.proxy_id, resolved.row.device_ip), {
        rowIndex,
        proxy_id: resolved.row.proxy_id,
        device_ip: resolved.row.device_ip,
        disposition: outcome.disposition
      });
    } catch (error) {
      if (error instanceof EdgeProbeAbortError) {
        abortDetail = error.problem.detail || error.message;
        for (let jump = index; jump < rows.length; jump += 1) {
          const abortRowIndex = jump + 1;
          const abortRaw = rows[jump];
          const abortOutcome: EdgeRowOutcome = {
            rowIndex: abortRowIndex,
            proxy_id: typeof abortRaw.proxy_id === 'string' ? abortRaw.proxy_id : '',
            device_ip: typeof abortRaw.device_ip === 'string' ? abortRaw.device_ip : '',
            disposition: 'aborted',
            attempts: 0,
            elapsedMs: 0,
            detail: abortDetail
          };
          outcomes.push(abortOutcome);
          totals.aborted += 1;
          appendReportLine(args.reportPath, { ...abortOutcome, runId, mode });
        }
        stoppedEarly = true;
        break;
      }
      throw error;
    }
  }

  return {
    schemaVersion: 'xyte.edge.claim-batch.v1',
    generatedAtUtc: new Date().toISOString(),
    tenantId: args.tenantId,
    mode,
    runId,
    ...(args.reportPath ? { reportPath: args.reportPath } : {}),
    ...(args.resumePath ? { resumePath: args.resumePath } : {}),
    totals,
    stoppedEarly,
    ...(abortDetail ? { abortDetail } : {}),
    rows: outcomes
  };
}

export function batchExitedClean(result: EdgeBatchResult): boolean {
  if (result.stoppedEarly) return false;
  const { failed, rejected, timeout, aborted, proxyOffline, pingFailed } = result.totals;
  return failed === 0 && rejected === 0 && timeout === 0 && aborted === 0 && proxyOffline === 0 && pingFailed === 0;
}

export function requireNonEmptyTenantId(tenantId: string | undefined, context: string): string {
  if (!tenantId || !tenantId.trim()) {
    throw new CliUserError({ summary: `${context} requires a tenant id.` });
  }
  return tenantId.trim();
}
