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

export type EdgeRowDisposition =
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'timeout'
  | 'already-claimed'
  | 'proxy-offline'
  | 'skipped'
  | 'aborted';

export interface EdgeClaimRow {
  rowIndex: number;
  proxy_id: string;
  device_ip: string;
  device_model_id: string;
  space_id: number;
  display_name?: string;
  custom_parameters?: Record<string, unknown>;
  custom_partner_name?: string;
  custom_model_name?: string;
  skip_connectivity_check?: boolean;
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
}

export interface EdgeBatchTotals {
  rows: number;
  succeeded: number;
  failed: number;
  rejected: number;
  timeout: number;
  alreadyClaimed: number;
  proxyOffline: number;
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

function buildClaimBody(row: EdgeClaimRow): Record<string, unknown> {
  const body: Record<string, unknown> = {
    proxy_id: row.proxy_id,
    device_ip: row.device_ip,
    device_model_id: row.device_model_id,
    space_id: row.space_id
  };
  if (row.display_name) body.display_name = row.display_name;
  if (row.custom_parameters) body.custom_parameters = row.custom_parameters;
  if (row.custom_partner_name) body.custom_partner_name = row.custom_partner_name;
  if (row.custom_model_name) body.custom_model_name = row.custom_model_name;
  if (row.skip_connectivity_check !== undefined) {
    body.skip_connectivity_check = row.skip_connectivity_check;
  }
  return body;
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

export interface RunEdgeClaimArgs {
  client: XyteClient;
  tenantId: string;
  row: EdgeClaimRow;
  pollOptions?: EdgePollOptions;
  sleeper?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export async function runEdgeClaim(args: RunEdgeClaimArgs): Promise<EdgeRowOutcome> {
  const startedAt = (args.now ?? Date.now)();

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
      disposition: 'rejected',
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
  'aborted'
]);

function resumeIdentityKey(proxyId: string, deviceIp: string): string {
  return `${proxyId}\u0000${deviceIp}`;
}

function loadResumeEntries(resumePath: string | undefined): Map<string, ResumeEntry> {
  const map = new Map<string, ResumeEntry>();
  if (!resumePath || !existsSync(resumePath)) return map;
  const raw = readFileSync(resumePath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ResumeEntry;
      if (
        parsed &&
        typeof parsed.rowIndex === 'number' &&
        typeof parsed.proxy_id === 'string' &&
        typeof parsed.device_ip === 'string' &&
        typeof parsed.disposition === 'string' &&
        RESUMABLE_DISPOSITIONS.has(parsed.disposition)
      ) {
        map.set(resumeIdentityKey(parsed.proxy_id, parsed.device_ip), parsed);
      }
    } catch {
      // Ignore malformed resume lines.
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
    skipped: 0,
    aborted: 0
  };
  const outcomes: EdgeRowOutcome[] = [];
  let stoppedEarly = false;
  let abortDetail: string | undefined;
  const resumeMap = loadResumeEntries(args.resumePath);
  const isResuming = resumeMap.size > 0 || (!!args.resumePath && existsSync(args.resumePath));

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
    if (
      existing &&
      (existing.disposition === 'succeeded' || existing.disposition === 'already-claimed')
    ) {
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

    if (!args.apply) {
      const outcome: EdgeRowOutcome = {
        rowIndex,
        proxy_id: validation.row.proxy_id,
        device_ip: validation.row.device_ip,
        disposition: 'skipped',
        attempts: 0,
        elapsedMs: 0,
        detail: 'Plan mode: skipped actual claim call.'
      };
      outcomes.push(outcome);
      totals.skipped += 1;
      appendReportLine(args.reportPath, { ...outcome, runId, mode, planned: buildClaimBody(validation.row) });
      continue;
    }

    try {
      const outcome = await runEdgeClaim({
        client: args.client,
        tenantId: args.tenantId,
        row: validation.row,
        pollOptions: args.pollOptions,
        sleeper: args.sleeper,
        now: args.now
      });
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
        default:
          break;
      }
      appendReportLine(args.reportPath, { ...outcome, runId, mode });
      appendResumeEntry(args.resumePath, {
        rowIndex,
        proxy_id: validation.row.proxy_id,
        device_ip: validation.row.device_ip,
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
  const { failed, rejected, timeout, aborted, proxyOffline } = result.totals;
  return failed === 0 && rejected === 0 && timeout === 0 && aborted === 0 && proxyOffline === 0;
}

export function requireNonEmptyTenantId(tenantId: string | undefined, context: string): string {
  if (!tenantId || !tenantId.trim()) {
    throw new CliUserError({ summary: `${context} requires a tenant id.` });
  }
  return tenantId.trim();
}
