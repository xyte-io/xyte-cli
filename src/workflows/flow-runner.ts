import { existsSync, mkdirSync } from 'node:fs';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import { buildCallEnvelope } from '../contracts/call-envelope';
import type { ProblemDetails } from '../contracts/problem';
import { INSPECT_DEEP_DIVE_SCHEMA_VERSION, UTILITY_BATCH_SCHEMA_VERSION } from '../contracts/versions';
import {
  buildFlowRunSummary,
  FlowRunDecisionSchema,
  FlowRunErrorEntrySchema,
  FlowRunSummarySchema,
  type FlowRunClassification,
  type FlowRunDecision,
  type FlowRunErrorEntry,
  type FlowRunStep,
  type FlowRunSummary
} from '../contracts/flow-run';
import { toProblemDetails } from '../client/errors';
import { buildStatusContract } from '../contracts/status';
import type { WatchFrameV1 } from '../contracts/watch-frame';
import { getEndpoint } from '../client/catalog';
import { evaluateReadiness } from '../config/readiness';
import type { ProfileStore, SecretStore } from '../types/stores';
import type { XyteClient } from '../types/client';
import { buildInstallDoctorReport } from './install-doctor';
import { getLogger } from '../observability/logger';
import { isMutatingMethod } from '../client/catalog';
import { isRecord } from '../utils/json';
import { errorMessage } from '../utils/error-format';
import { runWatch } from './watch';
import { runUtilityPrepare } from './utility-prepare';
import { runSpaceImportTree } from './utility-commands';
import { runDeviceMatch } from './device-match';
import { runMoveDevices } from './move-devices';
import { runVerifyMovedDevices } from './verify-device-moves';
import { runEdgeClaim, runEdgeClaimBatch, validateEdgeClaimRow, batchExitedClean } from './edge-claim';
import { runEdgePing } from './edge-ping';
import { parsePositiveInt as parseEdgePollPositiveInt } from './edge-poll';
import {
  buildDeepDive,
  buildFleetInspect,
  collectFleetSnapshot,
  generateDeviceMigrationReport,
  InspectProviderScopeError
} from './fleet-insights';
import { generateOpsReport, parseReportInput, type OpsReportInput } from './ops-report';
import { INSPECT_PROVIDER_SCOPES, type InspectProviderScope } from '../types/settings-enums';
import type { BuiltInFlowDefinition, FlowGateStep, FlowTaskStep } from './flow-catalog';
import { hasBuiltInFlowDefinition, getBuiltInFlowDefinition, UTILITY_PREPARE_CONTEXT_KEY } from './flow-catalog';
import { getFlowDefinition } from './flow-user-definitions';
import { CliUserError } from '../contracts/user-error';

export type FlowRunMode = 'plan' | 'apply';

class FlowNeedsInputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FlowNeedsInputError';
  }
}

type RunContextArgs = Omit<RunDeterministicFlowArgs, 'inspectProviderScope'> & { inspectProviderScope: InspectProviderScope };

interface RunContext {
  args: RunContextArgs;
  resolvedFlowId: string;
  definition: BuiltInFlowDefinition;
  bundleDir: string;
  stepsDir: string;
  outputsDir: string;
  manifestPath: string;
  inputsPath: string;
  decisionsPath: string;
  errorsPath: string;
  watchFramesPath: string;
  resolvedContext: Record<string, string>;
  taskOutputs: Map<string, unknown>;
}

type TaskExecutionResult =
  | { ok: true; output?: unknown; artifactPath?: string; primaryOutputPath?: string; watchFrames?: WatchFrameV1[]; contextUpdates?: Record<string, string> }
  | { ok: false; failureDetail: string; output?: unknown; artifactPath?: string; primaryOutputPath?: string; contextUpdates?: Record<string, string> };

interface FlowRunInputsPayload {
  flowId?: string;
  resolvedFlowId?: string;
  tenantId?: string;
  mode?: FlowRunMode;
  inspectProviderScope?: InspectProviderScope;
  context?: Record<string, string>;
  resume?: string;
  strictJson?: boolean;
  once?: boolean;
  generatedAtUtc?: string;
}

const FlowRunInputsPayloadSchema = z.object({
  flowId: z.string().optional(),
  resolvedFlowId: z.string().optional(),
  tenantId: z.string().optional(),
  mode: z.enum(['plan', 'apply']).optional(),
  inspectProviderScope: z.enum(INSPECT_PROVIDER_SCOPES).optional(),
  context: z.record(z.string(), z.string()).optional(),
  resume: z.string().optional(),
  strictJson: z.boolean().optional(),
  once: z.boolean().optional(),
  generatedAtUtc: z.string().optional()
});

interface RunDeterministicFlowArgs {
  flowId: string;
  tenantId: string;
  mode: FlowRunMode;
  inspectProviderScope?: InspectProviderScope;
  outDir: string;
  resume?: string;
  context: Record<string, string>;
  once: boolean;
  strictJson: boolean;
  profileStore: ProfileStore;
  secretStore: SecretStore;
  client: XyteClient;
}

async function collectFlowSnapshot(ctx: RunContext): Promise<ReturnType<typeof collectFleetSnapshot>> {
  const tenantProfile = await ctx.args.profileStore.getTenant(ctx.args.tenantId);
  try {
    return await collectFleetSnapshot({
      client: ctx.args.client,
      tenantId: ctx.args.tenantId,
      tenantName: tenantProfile?.name,
      providerScope: ctx.args.inspectProviderScope
    });
  } catch (error) {
    if (error instanceof InspectProviderScopeError) {
      throw new FlowNeedsInputError((error as Error).message, { cause: error });
    }
    throw error;
  }
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }
  return out;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeFlowId(flowId: string): string {
  return flowId.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function buildRunDirName(runId: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${stamp}-${runId}`;
}

function extractWatchContextUpdates(frames: WatchFrameV1[]): Record<string, string> | undefined {
  if (frames.length === 0 || !Array.isArray(frames[0].items) || frames[0].items.length === 0) {
    return undefined;
  }
  const first = frames[0].items[0];
  if (!isRecord(first)) {
    return undefined;
  }
  const updates: Record<string, string> = {};
  if (typeof first.device_id === 'string') updates.watch_device_id = first.device_id;
  if (typeof first.uuid === 'string') updates.watch_incident_id = first.uuid;
  if (typeof first.id === 'string') updates.watch_item_id = first.id;
  return Object.keys(updates).length > 0 ? updates : undefined;
}

export function parseFlowVarOptions(values: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of values ?? []) {
    const index = entry.indexOf('=');
    if (index <= 0) {
      throw new CliUserError({ summary: `Invalid --var entry: "${entry}". Use key=value.` });
    }
    const key = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    if (!key) {
      throw new CliUserError({ summary: `Invalid --var entry: "${entry}". Key cannot be empty.` });
    }
    out[key] = value;
  }
  return out;
}

const TEMPLATE_VAR_RE = /{{\s*([a-zA-Z0-9._-]+)\s*}}/g;

function resolveTemplateString(input: string, context: Record<string, string>): string {
  return input.replace(TEMPLATE_VAR_RE, (_all, rawKey: string) => {
    const key = rawKey.trim();
    const value = context[key];
    if (value === undefined) {
      throw new FlowNeedsInputError(`Missing required flow context: ${key}`);
    }
    return value;
  });
}

function resolveTemplateValue<T>(input: T, context: Record<string, string>): T {
  if (typeof input === 'string') {
    return resolveTemplateString(input, context) as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => resolveTemplateValue(item, context)) as T;
  }

  if (!isRecord(input)) {
    return input;
  }

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    out[key] = resolveTemplateValue(value, context);
  }
  return out as T;
}

function requireStepConfig<T>(value: T | undefined, stepId: string, label: string): T {
  if (!value) {
    throw new CliUserError({ summary: `Flow step ${stepId} is missing ${label} configuration.` });
  }
  return value;
}

function ensureContextKeys(step: FlowTaskStep, context: Record<string, string>): void {
  const required = step.requiresContext ?? [];
  const missing = required.filter((key) => !context[key]);
  if (missing.length > 0) {
    throw new FlowNeedsInputError(`Step ${step.id} requires context keys: ${missing.join(', ')}`);
  }
}

function resolveFlowWindowHours(step: FlowTaskStep, context: Record<string, string>): number {
  const rawOverride = context.window_hours?.trim();
  if (!rawOverride) {
    return step.inspect?.windowHours ?? 24;
  }

  const parsed = Number.parseInt(rawOverride, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return step.inspect?.windowHours ?? 24;
  }

  return parsed;
}

function promoteWatchOutputKeys(ctx: RunContext): void {
  const context = ctx.resolvedContext;

  if (!context.device_id && context.watch_device_id) {
    context.device_id = context.watch_device_id;
  }

  if (!context.incident_id) {
    const incidentId = context.watch_incident_id ?? context.watch_item_id;
    if (incidentId) {
      context.incident_id = incidentId;
    }
  }
}

function applyDefinitionContextDefaults(ctx: RunContext): void {
  if (!hasBuiltInFlowDefinition(ctx.resolvedFlowId)) {
    return;
  }
  const context = ctx.resolvedContext;
  const def = getBuiltInFlowDefinition(ctx.resolvedFlowId);
  for (const [key, template] of Object.entries(def.contextDefaults ?? {})) {
    if (!context[key]) {
      const value = template.replace(TEMPLATE_VAR_RE, (_, k: string) => context[k.trim()] ?? '');
      if (value && !value.includes('{{')) {
        context[key] = value;
      }
    }
  }
}

function classifyFailure(problem: ReturnType<typeof toProblemDetails>): FlowRunClassification {
  const detail = `${problem.detail} ${JSON.stringify(problem.upstream ?? {})}`.toLowerCase();
  if (
    problem.status === 422 &&
    (/valid command/.test(detail) || /friendly_name/.test(detail) || /no device found/.test(detail))
  ) {
    return 'needs_data';
  }
  if (problem.xyteCode === 'XYTE_FLOW_NEEDS_INPUT') {
    return 'needs_data';
  }
  return 'bug';
}

function toNeedsInputProblem(
  error: FlowNeedsInputError,
  instance: string
): ProblemDetails {
  return {
    type: 'https://xyte.dev/problems/flow-needs-input',
    title: 'Flow requires additional input',
    status: 422,
    detail: error.message,
    instance,
    xyteCode: 'XYTE_FLOW_NEEDS_INPUT',
    retriable: false
  };
}

function buildStepArtifactPath(ctx: RunContext, stepIndex: number, stepId: string, extension: string): string {
  const fileName = `${String(stepIndex + 1).padStart(2, '0')}-${stepId}.${extension}`;
  return path.join(ctx.stepsDir, fileName);
}

async function appendNdjson(targetPath: string, payload: unknown): Promise<void> {
  await appendFile(targetPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

async function recordStepFailure(
  stepState: FlowRunStep,
  problem: ReturnType<typeof toProblemDetails>,
  opts: {
    stepId: string;
    startedAt: number;
    errorsPath: string;
    errors: FlowRunErrorEntry[];
    artifactPath?: string;
  }
): Promise<FlowRunClassification> {
  const classification = classifyFailure(problem);
  stepState.status = 'failed';
  stepState.endedAtUtc = nowIso();
  stepState.durationMs = Date.now() - opts.startedAt;
  if (opts.artifactPath !== undefined) {
    stepState.artifactPath = opts.artifactPath;
  }
  stepState.error = problem;
  stepState.classification = classification;
  const errorEntry: FlowRunErrorEntry = {
    timestamp: nowIso(),
    stepId: opts.stepId,
    classification,
    error: problem
  };
  opts.errors.push(errorEntry);
  await appendNdjson(opts.errorsPath, errorEntry);
  return classification;
}

async function recordGatePending(
  stepState: FlowRunStep,
  opts: {
    stepId: string;
    requiresWrite: boolean;
    detail: string;
    decisionsPath: string;
    decisions: FlowRunDecision[];
  }
): Promise<void> {
  stepState.status = 'gate_pending';
  const decision: FlowRunDecision = {
    timestamp: nowIso(),
    stepId: opts.stepId,
    action: 'pending',
    detail: opts.detail,
    requiresWrite: opts.requiresWrite
  };
  opts.decisions.push(decision);
  await appendNdjson(opts.decisionsPath, decision);
}

function buildReportInputNeedsDataMessage(stepId: string, inputStepId: string, cause: unknown): string {
  const base = `Step ${stepId} requires report-compatible output from ${inputStepId}.`;
  if (!(cause instanceof Error) || cause.message.trim().length === 0) {
    return base;
  }
  return `${base} ${cause.message}`;
}


function extractCallOutputContext(
  data: unknown,
  spec: { contextKey: string; arrayPath: string; valueField: string }
): Record<string, string> | undefined {
  if (!isRecord(data)) return undefined;
  const arr = data[spec.arrayPath];
  if (!Array.isArray(arr)) return undefined;
  const first = arr.find((item): item is Record<string, unknown> => isRecord(item) && typeof item[spec.valueField] === 'string');
  return first ? { [spec.contextKey]: first[spec.valueField] as string } : undefined;
}

function evaluateReadinessWithConnectivity(ctx: RunContext): ReturnType<typeof evaluateReadiness> {
  return evaluateReadiness({ profileStore: ctx.args.profileStore, secretStore: ctx.args.secretStore, tenantId: ctx.args.tenantId, client: ctx.args.client, checkConnectivity: true });
}

async function handleSetupStatusStep(_step: FlowTaskStep, ctx: RunContext): Promise<TaskExecutionResult> {
  const readiness = await evaluateReadinessWithConnectivity(ctx);
  if (readiness.state !== 'ready') {
    throw new FlowNeedsInputError(`Setup status is ${readiness.state}. Run setup before continuing.`);
  }
  return { ok: true, output: readiness };
}

async function handleConfigDoctor(_step: FlowTaskStep, ctx: RunContext): Promise<TaskExecutionResult> {
  const readiness = await evaluateReadinessWithConnectivity(ctx);
  if (readiness.connectionState !== 'connected') {
    throw new FlowNeedsInputError(
      `Connectivity is ${readiness.connectionState}. Resolve connectivity before continuing.`
    );
  }
  return { ok: true, output: { retryAttempts: 2, retryBackoffMs: 250, readiness } };
}

async function handleStatusFast(_step: FlowTaskStep, ctx: RunContext): Promise<TaskExecutionResult> {
  const readiness = await evaluateReadiness({ profileStore: ctx.args.profileStore, secretStore: ctx.args.secretStore, tenantId: ctx.args.tenantId, checkConnectivity: false });
  return { ok: true, output: buildStatusContract({ mode: 'fast', checkConnectivity: false, readiness }) };
}

async function handleFleetInspect(_step: FlowTaskStep, ctx: RunContext): Promise<TaskExecutionResult> {
  const snapshot = await collectFlowSnapshot(ctx);
  return { ok: true, output: buildFleetInspect(snapshot) };
}

async function handleDeepDive(step: FlowTaskStep, ctx: RunContext): Promise<TaskExecutionResult> {
  const windowHours = resolveFlowWindowHours(step, ctx.resolvedContext);
  const snapshot = await collectFlowSnapshot(ctx);
  return { ok: true, output: buildDeepDive(snapshot, windowHours) };
}

function handleMigrationReport(args: {
  stepId: string;
  inputFromStepId: string;
  fleetFromStepId: string;
  verificationFromStepId: string;
  reportInput: OpsReportInput;
  taskOutputs: Map<string, unknown>;
  tenantId: string;
  outPath: string;
}): TaskExecutionResult {
  const { stepId, inputFromStepId, fleetFromStepId, verificationFromStepId, reportInput, taskOutputs, tenantId, outPath } = args;
  if (reportInput.schemaVersion !== UTILITY_BATCH_SCHEMA_VERSION || reportInput.command !== 'device.move') {
    throw new FlowNeedsInputError(`Step ${stepId} requires device.move batch output from ${inputFromStepId}.`);
  }
  const fleetInput = taskOutputs.get(fleetFromStepId);
  const verificationInput = taskOutputs.get(verificationFromStepId);
  if (!fleetInput || typeof fleetInput !== 'object') {
    throw new FlowNeedsInputError(`Step ${stepId}: fleet snapshot from ${fleetFromStepId} is missing or invalid.`);
  }
  const generated = generateDeviceMigrationReport({
    execution: reportInput,
    fleet: fleetInput,
    verification: verificationInput,
    tenantId,
    outPath
  });
  return { ok: true, output: generated, artifactPath: outPath, primaryOutputPath: outPath };
}

async function handleOpsReport(args: {
  reportInput: OpsReportInput;
  format: 'markdown' | 'pdf';
  includeSensitive: boolean;
  tenantId: string;
  outPath: string;
}): Promise<TaskExecutionResult> {
  const { reportInput, format, includeSensitive, tenantId, outPath } = args;
  if (format === 'pdf' && reportInput.schemaVersion !== INSPECT_DEEP_DIVE_SCHEMA_VERSION) {
    throw new CliUserError({ summary: 'PDF format is only supported for fleet deep-dive reports' });
  }
  const generated = await generateOpsReport({ input: reportInput, tenantId, format, outPath, includeSensitive });
  return { ok: true, output: generated, artifactPath: outPath, primaryOutputPath: outPath };
}

async function handleReportGenerate(step: FlowTaskStep, ctx: RunContext): Promise<TaskExecutionResult> {
  const report = requireStepConfig(step.report, step.id, 'report');
  const input = ctx.taskOutputs.get(report.inputFromStepId);
  let reportInput: OpsReportInput;
  try {
    reportInput = parseReportInput(input, ctx.args.tenantId);
  } catch (error) {
    throw new FlowNeedsInputError(buildReportInputNeedsDataMessage(step.id, report.inputFromStepId, error), { cause: error });
  }
  const outPath = path.join(ctx.outputsDir, report.outFileName);
  const { fleetFromStepId, verificationFromStepId } = report;
  if (fleetFromStepId && verificationFromStepId) {
    return handleMigrationReport({
      stepId: step.id,
      inputFromStepId: report.inputFromStepId,
      fleetFromStepId,
      verificationFromStepId,
      reportInput,
      taskOutputs: ctx.taskOutputs,
      tenantId: ctx.args.tenantId,
      outPath
    });
  }
  return handleOpsReport({
    reportInput,
    format: report.format,
    includeSensitive: report.includeSensitive === true,
    tenantId: ctx.args.tenantId,
    outPath
  });
}

async function handleWatch(step: FlowTaskStep, stepIndex: number, ctx: RunContext): Promise<TaskExecutionResult> {
  const watchConfig = requireStepConfig(step.watch, step.id, 'watch');
  const frames: WatchFrameV1[] = [];
  const once = ctx.args.once || watchConfig.once;
  await runWatch({
    client: ctx.args.client,
    tenantId: ctx.args.tenantId,
    profile: watchConfig.profile,
    once,
    intervalMs: watchConfig.intervalMs,
    maxPolls: once ? 1 : watchConfig.maxPolls,
    onFrame: (frame) => {
      frames.push(frame);
    }
  });
  const watchStepPath = buildStepArtifactPath(ctx, stepIndex, step.id, 'ndjson');
  await writeFile(
    watchStepPath,
    frames.length > 0 ? `${frames.map((item) => JSON.stringify(item)).join('\n')}\n` : '',
    'utf8'
  );
  return {
    ok: true,
    output: {
      frameCount: frames.length,
      lastEventType: frames.length > 0 ? frames[frames.length - 1].eventType : undefined
    },
    artifactPath: watchStepPath,
    watchFrames: frames,
    contextUpdates: extractWatchContextUpdates(frames)
  };
}

async function handleCall(step: FlowTaskStep, _stepIndex: number, ctx: RunContext): Promise<TaskExecutionResult> {
  const callConfig = requireStepConfig(step.call, step.id, 'call');
  const endpoint = getEndpoint(callConfig.endpointKey);
  const method = endpoint.method.toUpperCase();
  const isWrite = isMutatingMethod(method);
  const requestId = randomUUID();
  const pathPayload = callConfig.path ? resolveTemplateValue(callConfig.path, ctx.resolvedContext) : undefined;
  const queryPayload = callConfig.query ? resolveTemplateValue(callConfig.query, ctx.resolvedContext) : undefined;
  const bodyPayload = callConfig.body ? resolveTemplateValue(callConfig.body, ctx.resolvedContext) : undefined;
  const result = await ctx.args.client.callWithMeta(callConfig.endpointKey, {
    requestId,
    tenantId: ctx.args.tenantId,
    ...(pathPayload ? { path: pathPayload } : {}),
    ...(queryPayload ? { query: queryPayload } : {}),
    ...(bodyPayload !== undefined ? { body: bodyPayload } : {})
  });
  const envelope = buildCallEnvelope({
    requestId,
    tenantId: ctx.args.tenantId,
    endpointKey: callConfig.endpointKey,
    method,
    guard: { allowWrite: isWrite },
    request: { path: pathPayload, query: queryPayload, body: bodyPayload },
    response: { status: result.status, durationMs: result.durationMs, retryCount: result.retryCount, data: result.data }
  });
  return {
    ok: true,
    output: envelope,
    contextUpdates: callConfig.outputContext
      ? extractCallOutputContext(result.data, callConfig.outputContext)
      : undefined
  };
}

function handleUtilityPrepare(step: FlowTaskStep, _stepIndex: number, ctx: RunContext): TaskExecutionResult {
  const utilityPrepare = requireStepConfig(step.utilityPrepare, step.id, 'utility prepare');
  const inputPath = path.resolve(resolveTemplateString(utilityPrepare.inputPath, ctx.resolvedContext));
  const outputDir = path.join(ctx.outputsDir, path.basename(utilityPrepare.outputDir));
  const result = runUtilityPrepare({
    inputPath,
    actionKey: utilityPrepare.actionKey,
    outputDir,
    tenantId: ctx.args.tenantId,
    primaryFormat: utilityPrepare.primaryFormat,
    force: true
  });
  const contextKey = UTILITY_PREPARE_CONTEXT_KEY[utilityPrepare.actionKey];
  const contextUpdates: Record<string, string> = contextKey ? { [contextKey]: result.artifacts.primary } : {};
  return { ok: true, output: result, primaryOutputPath: result.artifacts.primary, contextUpdates };
}

async function handleDeviceMatch(step: FlowTaskStep, _stepIndex: number, ctx: RunContext): Promise<TaskExecutionResult> {
  const deviceMatch = requireStepConfig(step.deviceMatch, step.id, 'device match');
  const sourcePath = path.resolve(resolveTemplateString(deviceMatch.sourcePath, ctx.resolvedContext));
  const targetPath = path.resolve(resolveTemplateString(deviceMatch.targetPath, ctx.resolvedContext));
  const outputPath = path.join(ctx.outputsDir, path.basename(deviceMatch.outputPath));
  const result = await runDeviceMatch({
    sourcePath,
    targetPath,
    sourceField: deviceMatch.sourceField,
    targetField: deviceMatch.targetField,
    outputPath,
    tenantId: ctx.args.tenantId
  });
  return { ok: true, output: result, primaryOutputPath: outputPath };
}

async function handleDeviceMoveBatch(step: FlowTaskStep, _stepIndex: number, ctx: RunContext): Promise<TaskExecutionResult> {
  const deviceMoveBatch = requireStepConfig(step.deviceMoveBatch, step.id, 'device move batch');
  const inputPath = path.resolve(resolveTemplateString(deviceMoveBatch.inputPath, ctx.resolvedContext));
  const reportPath = path.join(ctx.outputsDir, path.basename(deviceMoveBatch.reportPath));
  const result = await runMoveDevices({
    client: ctx.args.client,
    tenantId: ctx.args.tenantId,
    inputPath,
    apply: deviceMoveBatch.apply,
    continueOnError: deviceMoveBatch.continueOnError === true,
    reportPath
  });
  const contextUpdates: Record<string, string> = deviceMoveBatch.apply
    ? { execute_moves_report_path: reportPath }
    : { dry_run_moves_report_path: reportPath };
  if (result.totals.failed > 0 || result.stoppedEarly) {
    return { ok: false, failureDetail: `Step ${step.id} failed because the move batch reported ${result.totals.failed} failed row(s).`, output: result, primaryOutputPath: reportPath, contextUpdates };
  }
  return { ok: true, output: result, primaryOutputPath: reportPath, contextUpdates };
}

async function handleDeviceVerifyBatch(step: FlowTaskStep, stepIndex: number, ctx: RunContext): Promise<TaskExecutionResult> {
  const deviceVerifyBatch = requireStepConfig(step.deviceVerifyBatch, step.id, 'device verification');
  const inputPath = path.resolve(resolveTemplateString(deviceVerifyBatch.inputPath, ctx.resolvedContext));
  const artifactPath = buildStepArtifactPath(ctx, stepIndex, step.id, 'json');
  const result = await runVerifyMovedDevices({
    client: ctx.args.client,
    tenantId: ctx.args.tenantId,
    inputPath,
    outputPath: artifactPath
  });
  if (result.totals.mismatched > 0 || result.totals.missing > 0) {
    return { ok: false, failureDetail: `Step ${step.id} found ${result.totals.mismatched} mismatched and ${result.totals.missing} missing planned device(s).`, output: result, artifactPath };
  }
  return { ok: true, output: result, artifactPath };
}

async function handleSpaceImportTree(step: FlowTaskStep, _stepIndex: number, ctx: RunContext): Promise<TaskExecutionResult> {
  const spaceImportTree = requireStepConfig(step.spaceImportTree, step.id, 'space import');
  const inputPath = path.resolve(resolveTemplateString(spaceImportTree.inputPath, ctx.resolvedContext));
  const reportPath = path.join(ctx.outputsDir, path.basename(spaceImportTree.reportPath));
  const result = await runSpaceImportTree({
    client: ctx.args.client,
    tenantId: ctx.args.tenantId,
    inputPath,
    apply: spaceImportTree.apply,
    continueOnError: false,
    reportPath
  });
  return { ok: true, output: result, artifactPath: reportPath, primaryOutputPath: reportPath };
}

function resolvePollOptions(ctx: RunContext, intervalKey?: string, timeoutKey?: string): { intervalMs?: number; timeoutMs?: number } {
  const options: { intervalMs?: number; timeoutMs?: number } = {};
  const resolvedIntervalKey = intervalKey ?? 'edge_poll_interval_ms';
  const resolvedTimeoutKey = timeoutKey ?? 'edge_poll_timeout_ms';
  const intervalRaw = ctx.resolvedContext[resolvedIntervalKey];
  const timeoutRaw = ctx.resolvedContext[resolvedTimeoutKey];
  const interval = parseEdgePollPositiveInt(intervalRaw, resolvedIntervalKey);
  const timeout = parseEdgePollPositiveInt(timeoutRaw, resolvedTimeoutKey);
  if (interval !== undefined) options.intervalMs = interval;
  if (timeout !== undefined) options.timeoutMs = timeout;
  return options;
}

async function handleEdgeClaim(step: FlowTaskStep, _stepIndex: number, ctx: RunContext): Promise<TaskExecutionResult> {
  const context = ctx.resolvedContext;
  const raw: Record<string, unknown> = {
    proxy_id: context.proxy_id,
    device_ip: context.device_ip,
    device_model_id: context.device_model_id,
    space_id: context.space_id,
    display_name: context.display_name,
    skip_connectivity_check: context.skip_connectivity_check,
    custom_parameters: context.custom_parameters,
    custom_partner_name: context.custom_partner_name,
    custom_model_name: context.custom_model_name
  };
  const validation = validateEdgeClaimRow(raw, 1);
  if (!validation.ok) {
    return { ok: false, failureDetail: `Step ${step.id}: ${validation.reason}` };
  }
  const outcome = await runEdgeClaim({
    client: ctx.args.client,
    tenantId: ctx.args.tenantId,
    row: validation.row,
    pollOptions: resolvePollOptions(ctx, step.edgeClaim?.pollIntervalMsKey, step.edgeClaim?.pollTimeoutMsKey)
  });
  const ok = outcome.disposition === 'succeeded' || outcome.disposition === 'already-claimed';
  if (!ok) {
    return {
      ok: false,
      failureDetail: `Edge claim ${outcome.disposition}${outcome.detail ? `: ${outcome.detail}` : ''}.`,
      output: outcome
    };
  }
  return { ok: true, output: outcome };
}

async function handleEdgeClaimBatch(step: FlowTaskStep, _stepIndex: number, ctx: RunContext): Promise<TaskExecutionResult> {
  const config = requireStepConfig(step.edgeClaimBatch, step.id, 'edge claim batch');
  const inputPath = path.resolve(resolveTemplateString(config.inputPath, ctx.resolvedContext));
  const reportPath = path.join(ctx.outputsDir, path.basename(config.reportPath));
  const resumePath = path.join(ctx.outputsDir, path.basename(config.resumePath));
  const result = await runEdgeClaimBatch({
    client: ctx.args.client,
    tenantId: ctx.args.tenantId,
    inputPath,
    apply: config.apply,
    reportPath,
    resumePath,
    pollOptions: resolvePollOptions(ctx, config.pollIntervalMsKey, config.pollTimeoutMsKey)
  });
  const contextUpdates: Record<string, string> = config.apply
    ? { edge_claim_apply_report_path: reportPath }
    : { edge_claim_dry_run_report_path: reportPath };
  if (!batchExitedClean(result)) {
    return {
      ok: false,
      failureDetail: `Edge claim batch reported ${result.totals.failed} failed, ${result.totals.rejected} rejected, ${result.totals.timeout} timeout, ${result.totals.proxyOffline} proxy-offline, ${result.totals.aborted} aborted row(s).`,
      output: result,
      primaryOutputPath: reportPath,
      contextUpdates
    };
  }
  return { ok: true, output: result, primaryOutputPath: reportPath, contextUpdates };
}

async function handleEdgePing(step: FlowTaskStep, _stepIndex: number, ctx: RunContext): Promise<TaskExecutionResult> {
  const context = ctx.resolvedContext;
  const proxyId = context.proxy_id?.trim();
  const deviceIp = context.device_ip?.trim();
  if (!proxyId || !deviceIp) {
    return { ok: false, failureDetail: `Step ${step.id} requires context keys proxy_id and device_ip.` };
  }
  const outcome = await runEdgePing({
    client: ctx.args.client,
    tenantId: ctx.args.tenantId,
    proxy_id: proxyId,
    device_ip: deviceIp,
    pollOptions: resolvePollOptions(ctx, step.edgePing?.pollIntervalMsKey, step.edgePing?.pollTimeoutMsKey)
  });
  if (outcome.disposition !== 'succeeded') {
    return {
      ok: false,
      failureDetail: `Edge ping ${outcome.disposition}${outcome.detail ? `: ${outcome.detail}` : ''}.`,
      output: outcome
    };
  }
  return { ok: true, output: outcome };
}

async function runTaskStep(step: FlowTaskStep, stepIndex: number, ctx: RunContext): Promise<TaskExecutionResult> {
  promoteWatchOutputKeys(ctx);
  applyDefinitionContextDefaults(ctx);
  ensureContextKeys(step, ctx.resolvedContext);

  switch (step.task) {
    case 'doctor.install':    return { ok: true, output: buildInstallDoctorReport(path.resolve(__dirname, '../../dist/bin/xyte-cli.js')) };
    case 'setup.status':      return handleSetupStatusStep(step, ctx);
    case 'config.doctor':     return handleConfigDoctor(step, ctx);
    case 'status.fast':       return handleStatusFast(step, ctx);
    case 'inspect.fleet':     return handleFleetInspect(step, ctx);
    case 'inspect.deep-dive': return handleDeepDive(step, ctx);
    case 'report.generate':   return handleReportGenerate(step, ctx);
    case 'watch':             return handleWatch(step, stepIndex, ctx);
    case 'call':              return handleCall(step, stepIndex, ctx);
    case 'utility.prepare':   return handleUtilityPrepare(step, stepIndex, ctx);
    case 'device.match':      return handleDeviceMatch(step, stepIndex, ctx);
    case 'device.move-batch': return handleDeviceMoveBatch(step, stepIndex, ctx);
    case 'device.verify-batch': return handleDeviceVerifyBatch(step, stepIndex, ctx);
    case 'space.import-tree': return handleSpaceImportTree(step, stepIndex, ctx);
    case 'edge.claim':        return handleEdgeClaim(step, stepIndex, ctx);
    case 'edge.claim-batch':  return handleEdgeClaimBatch(step, stepIndex, ctx);
    case 'edge.ping':         return handleEdgePing(step, stepIndex, ctx);
    default: throw new Error(`Unsupported flow task type: ${(step as { task: string }).task}`);
  }
}

function computeDecisionCounts(decisions: FlowRunDecision[]): { pending: number; approved: number; blocked: number } {
  return {
    pending: decisions.filter((item) => item.action === 'pending').length,
    approved: decisions.filter((item) => item.action === 'approved').length,
    blocked: decisions.filter((item) => item.action === 'blocked').length
  };
}

function computeClassificationCounts(errors: FlowRunErrorEntry[]): { needs_data: number; bug: number } {
  return {
    needs_data: errors.filter((item) => item.classification === 'needs_data').length,
    bug: errors.filter((item) => item.classification === 'bug').length
  };
}

async function findRunBundle(outDir: string, resumeRef: string): Promise<string> {
  if (!resumeRef.trim()) {
    throw new CliUserError({ summary: 'Invalid --resume value.' });
  }

  const direct = path.resolve(resumeRef);
  if (existsSync(path.join(direct, 'manifest.json'))) {
    return direct;
  }

  const root = path.resolve(outDir);
  const flowDirs = await readdir(root, { withFileTypes: true }).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return [];
    throw err;
  });
  for (const flowDir of flowDirs) {
    if (!flowDir.isDirectory()) {
      continue;
    }
    const runDirs = await readdir(path.join(root, flowDir.name), { withFileTypes: true }).catch(
      (err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return [];
        throw err;
      }
    );
    for (const runDir of runDirs) {
      if (!runDir.isDirectory()) {
        continue;
      }
      const candidate = path.join(root, flowDir.name, runDir.name);
      const manifestPath = path.join(candidate, 'manifest.json');
      if (!existsSync(manifestPath)) {
        continue;
      }
      try {
        const parsed = JSON.parse(await readFile(manifestPath, 'utf8')) as { runId?: string };
        if (parsed.runId === resumeRef.trim()) {
          return candidate;
        }
      } catch (error) {
        getLogger().debug({ manifestPath, error: errorMessage(error) }, 'Skipping malformed manifest during resume search');
      }
    }
  }

  throw new CliUserError({ summary: `Unable to resolve resume run: ${resumeRef}` });
}

function createInitialSteps(definition: BuiltInFlowDefinition): FlowRunStep[] {
  return definition.steps.map((step) => ({
    stepId: step.id,
    title: step.title,
    kind: step.kind,
    command: step.command,
    status: 'pending'
  }));
}

async function readLinesAsJson<T>(
  filePath: string,
  schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }
): Promise<T[]> {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = await readFile(filePath, 'utf8');
  const items: T[] = [];
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length; index += 1) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(lines[index]);
    } catch {
      throw new CliUserError({ summary: `Invalid JSON line ${index + 1} in ${filePath}.` });
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new CliUserError({ summary: `Unexpected shape on line ${index + 1} in ${filePath}.` });
    }
    items.push(result.data);
  }

  return items;
}

function isInspectProviderScopeValue(value: unknown): value is InspectProviderScope {
  return (INSPECT_PROVIDER_SCOPES as readonly string[]).includes(value as string);
}

async function readStoredInspectProviderScope(bundleDir: string): Promise<InspectProviderScope | undefined> {
  const storedInputs = await readStoredInputs(bundleDir);
  return storedInputs && isInspectProviderScopeValue(storedInputs.inspectProviderScope)
    ? storedInputs.inspectProviderScope
    : undefined;
}

async function readStoredInputs(bundleDir: string): Promise<FlowRunInputsPayload | undefined> {
  const inputsPath = path.join(bundleDir, 'inputs.json');
  if (!existsSync(inputsPath)) {
    return undefined;
  }

  try {
    const result = FlowRunInputsPayloadSchema.safeParse(JSON.parse(await readFile(inputsPath, 'utf8')));
    if (!result.success) {
      getLogger().warn({ inputsPath, issues: result.error.issues }, 'Malformed resume inputs — falling back to invocation defaults');
      return undefined;
    }
    return result.data;
  } catch (error) {
    getLogger().warn({ inputsPath, error }, 'Malformed resume inputs — falling back to invocation defaults');
    return undefined;
  }
}

function buildFlowRunInputsPayload(
  ctx: Pick<RunContext, 'resolvedContext' | 'resolvedFlowId'>,
  args: RunDeterministicFlowArgs,
  inspectProviderScope: InspectProviderScope
): FlowRunInputsPayload {
  return {
    flowId: args.flowId,
    resolvedFlowId: ctx.resolvedFlowId,
    tenantId: args.tenantId,
    mode: args.mode,
    inspectProviderScope,
    context: ctx.resolvedContext,
    resume: args.resume,
    strictJson: args.strictJson,
    once: args.once,
    generatedAtUtc: nowIso()
  };
}

async function persistFlowRunInputs(
  ctx: Pick<RunContext, 'inputsPath' | 'resolvedContext' | 'resolvedFlowId'>,
  args: RunDeterministicFlowArgs,
  inspectProviderScope: InspectProviderScope
): Promise<void> {
  await writeFile(
    ctx.inputsPath,
    `${JSON.stringify(buildFlowRunInputsPayload(ctx, args, inspectProviderScope), null, 2)}\n`,
    'utf8'
  );
}

async function restoreTaskOutputsFromSteps(steps: FlowRunStep[]): Promise<Map<string, unknown>> {
  const taskOutputs = new Map<string, unknown>();
  for (const step of steps) {
    if (step.status !== 'completed') {
      continue;
    }
    if (typeof step.artifactPath !== 'string' || !step.artifactPath.endsWith('.json')) {
      continue;
    }
    if (!existsSync(step.artifactPath)) {
      continue;
    }
    try {
      const parsed = JSON.parse(await readFile(step.artifactPath, 'utf8')) as unknown;
      taskOutputs.set(step.stepId, parsed);
    } catch (error) {
      getLogger().warn({ stepId: step.stepId, error: errorMessage(error) }, 'Failed to restore task artifact from step during resume hydration');
    }
  }
  return taskOutputs;
}

async function writeSummaryToManifest(summary: FlowRunSummary, manifestPath: string): Promise<void> {
  await writeFile(manifestPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

interface ResumeState {
  runId: string;
  bundleDir: string;
  initialStartedAtUtc: string;
  steps: FlowRunStep[];
  cursorIndex: number;
  priorDecisions: FlowRunDecision[];
  priorErrors: FlowRunErrorEntry[];
  resumedInspectProviderScope: InspectProviderScope | undefined;
  resumedContext: Record<string, string>;
}

async function loadResumeState(resumeBundle: string): Promise<ResumeState> {
  const manifestPath = path.join(resumeBundle, 'manifest.json');
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new CliUserError({ summary: `Resume bundle manifest could not be read: ${manifestPath}` });
  }
  let existingSummary: FlowRunSummary;
  try {
    existingSummary = FlowRunSummarySchema.parse(JSON.parse(raw));
  } catch {
    throw new CliUserError({ summary: `Resume bundle manifest is invalid JSON or has unexpected shape: ${manifestPath}` });
  }
  const storedInputs = await readStoredInputs(resumeBundle);
  return {
    runId: existingSummary.runId,
    bundleDir: resumeBundle,
    initialStartedAtUtc: existingSummary.startedAtUtc,
    steps: existingSummary.steps,
    cursorIndex: existingSummary.cursor.nextStepIndex,
    priorDecisions: await readLinesAsJson(path.join(resumeBundle, 'decisions.ndjson'), FlowRunDecisionSchema),
    priorErrors: await readLinesAsJson(path.join(resumeBundle, 'errors.ndjson'), FlowRunErrorEntrySchema),
    resumedInspectProviderScope: await readStoredInspectProviderScope(resumeBundle),
    resumedContext: toStringRecord(storedInputs?.context)
  };
}

async function ensureRunPaths(ctx: RunContext): Promise<void> {
  mkdirSync(ctx.stepsDir, { recursive: true });
  mkdirSync(ctx.outputsDir, { recursive: true });
  if (!existsSync(ctx.decisionsPath)) {
    await writeFile(ctx.decisionsPath, '', 'utf8');
  }
  if (!existsSync(ctx.errorsPath)) {
    await writeFile(ctx.errorsPath, '', 'utf8');
  }
  if (!existsSync(ctx.watchFramesPath)) {
    await writeFile(ctx.watchFramesPath, '', 'utf8');
  }
}

interface RunState {
  ctx: RunContext;
  runId: string;
  initialStartedAtUtc: string;
  cursorIndex: number;
  steps: FlowRunStep[];
  priorDecisions: FlowRunDecision[];
  priorErrors: FlowRunErrorEntry[];
}

interface ExecuteStepsResult {
  outcome: FlowRunSummary['outcome'];
  nextStepIndex: number;
  decisions: FlowRunDecision[];
  errors: FlowRunErrorEntry[];
  durationMs: number;
}

async function resolveFlowDefinition(flowId: string): Promise<{
  definition: BuiltInFlowDefinition;
  resolvedFlowId: string;
  flowDefaults: Record<string, string>;
}> {
  let resolvedFlowId = flowId;
  let flowDefaults: Record<string, string> = {};
  if (!hasBuiltInFlowDefinition(flowId)) {
    const custom = await getFlowDefinition(flowId);
    if (!custom) {
      throw new CliUserError({ summary: `Unknown flow id: ${flowId}` });
    }
    if (!hasBuiltInFlowDefinition(custom.basedOn)) {
      throw new CliUserError({
        summary: `Custom flow ${flowId} references unknown built-in base flow: ${custom.basedOn}`
      });
    }
    resolvedFlowId = custom.basedOn;
    flowDefaults = custom.defaults;
  }
  return { definition: getBuiltInFlowDefinition(resolvedFlowId), resolvedFlowId, flowDefaults };
}

async function hydrateResume(
  outRoot: string,
  resumeRef: string | undefined,
  freshRunId: string,
  definition: BuiltInFlowDefinition,
  flowId: string
): Promise<{
  resume: ResumeState | undefined;
  runId: string;
  bundleDir: string;
  initialStartedAtUtc: string;
  steps: FlowRunStep[];
  cursorIndex: number;
  priorDecisions: FlowRunDecision[];
  priorErrors: FlowRunErrorEntry[];
}> {
  const resumeBundle = resumeRef ? await findRunBundle(outRoot, resumeRef) : undefined;
  const resume = resumeBundle ? await loadResumeState(resumeBundle) : undefined;
  const runId = resume?.runId ?? freshRunId;
  const bundleDir = resume?.bundleDir ?? path.join(outRoot, sanitizeFlowId(flowId), buildRunDirName(freshRunId));
  const initialStartedAtUtc = resume?.initialStartedAtUtc ?? nowIso();
  const steps = resume?.steps ?? createInitialSteps(definition);
  const cursorIndex = resume?.cursorIndex ?? 0;
  const priorDecisions = resume?.priorDecisions ?? [];
  const priorErrors = resume?.priorErrors ?? [];
  return { resume, runId, bundleDir, initialStartedAtUtc, steps, cursorIndex, priorDecisions, priorErrors };
}

async function initRunState(args: RunDeterministicFlowArgs): Promise<RunState> {
  const { definition, resolvedFlowId, flowDefaults } = await resolveFlowDefinition(args.flowId);
  const outRoot = path.resolve(args.outDir);
  const freshRunId = randomUUID();
  const { resume, runId, bundleDir, initialStartedAtUtc, steps, cursorIndex, priorDecisions, priorErrors } =
    await hydrateResume(outRoot, args.resume, freshRunId, definition, args.flowId);

  const effectiveInspectProviderScope = args.inspectProviderScope ?? resume?.resumedInspectProviderScope ?? 'auto';
  const restoredTaskOutputs = resume ? await restoreTaskOutputsFromSteps(steps) : new Map<string, unknown>();
  const ctx: RunContext = {
    args: {
      ...args,
      inspectProviderScope: effectiveInspectProviderScope
    },
    resolvedFlowId,
    definition,
    bundleDir,
    stepsDir: path.join(bundleDir, 'steps'),
    outputsDir: path.join(bundleDir, 'outputs'),
    manifestPath: path.join(bundleDir, 'manifest.json'),
    inputsPath: path.join(bundleDir, 'inputs.json'),
    decisionsPath: path.join(bundleDir, 'decisions.ndjson'),
    errorsPath: path.join(bundleDir, 'errors.ndjson'),
    watchFramesPath: path.join(bundleDir, 'watch-frames.ndjson'),
    resolvedContext: {
      ...(resume?.resumedContext ?? {}),
      ...flowDefaults,
      ...args.context
    },
    taskOutputs: restoredTaskOutputs
  };

  await ensureRunPaths(ctx);
  await persistFlowRunInputs(ctx, ctx.args, effectiveInspectProviderScope);

  return { ctx, runId, initialStartedAtUtc, cursorIndex, steps, priorDecisions, priorErrors };
}

async function handleGateStep(
  step: FlowGateStep,
  stepState: FlowRunStep,
  ctx: RunContext,
  decisions: FlowRunDecision[],
  gateApprovalsThisRun: number,
  index: number
): Promise<
  | { action: 'pause'; nextStepIndex: number; gateApprovalsThisRun: number; outcome: 'pending_gate' }
  | { action: 'continue'; nextStepIndex: number; gateApprovalsThisRun: number }
> {
  if (ctx.args.mode === 'plan') {
    await recordGatePending(stepState, {
      stepId: step.id,
      requiresWrite: step.mutating,
      detail: 'Plan mode paused at human decision gate.',
      decisionsPath: ctx.decisionsPath,
      decisions
    });
    return { action: 'pause', nextStepIndex: index, gateApprovalsThisRun, outcome: 'pending_gate' };
  }

  if (step.pauseOnFirstApply === true && gateApprovalsThisRun === 0) {
    await recordGatePending(stepState, {
      stepId: step.id,
      requiresWrite: step.mutating,
      detail: 'Apply mode paused at a gate that requires explicit resume approval.',
      decisionsPath: ctx.decisionsPath,
      decisions
    });
    return { action: 'pause', nextStepIndex: index, gateApprovalsThisRun, outcome: 'pending_gate' };
  }

  if (gateApprovalsThisRun >= 1) {
    await recordGatePending(stepState, {
      stepId: step.id,
      requiresWrite: step.mutating,
      detail: 'Single-gate apply limit reached for this invocation.',
      decisionsPath: ctx.decisionsPath,
      decisions
    });
    return { action: 'pause', nextStepIndex: index, gateApprovalsThisRun, outcome: 'pending_gate' };
  }

  stepState.status = 'gate_approved';
  const decision: FlowRunDecision = {
    timestamp: nowIso(),
    stepId: step.id,
    action: 'approved',
    detail: 'Gate approved by apply mode execution.',
    requiresWrite: step.mutating
  };
  decisions.push(decision);
  await appendNdjson(ctx.decisionsPath, decision);
  return { action: 'continue', nextStepIndex: index + 1, gateApprovalsThisRun: gateApprovalsThisRun + 1 };
}

async function recordStepSuccess(
  result: TaskExecutionResult,
  step: FlowTaskStep,
  stepState: FlowRunStep,
  ctx: RunContext,
  artifactPath: string,
  stepStartedAt: number
): Promise<void> {
  stepState.status = 'completed';
  stepState.endedAtUtc = nowIso();
  stepState.durationMs = Date.now() - stepStartedAt;
  stepState.artifactPath = artifactPath;
  // Convention: <stepId>_artifact holds the primary artifact path (e.g. CSV written by a utility-prepare step).
  ctx.resolvedContext[`${step.id}_artifact`] = artifactPath;

  if (result.ok && result.watchFrames && result.watchFrames.length > 0) {
    for (const frame of result.watchFrames) {
      await appendNdjson(ctx.watchFramesPath, frame);
    }
  }

  if (result.contextUpdates) {
    Object.assign(ctx.resolvedContext, result.contextUpdates);
  }

  if (result.output !== undefined) {
    ctx.taskOutputs.set(step.id, result.output);
  }

  const primaryOutputPath = result.primaryOutputPath;
  if (primaryOutputPath) {
    // Convention: <stepId>_output holds the primary output path (e.g. NDJSON written by a match/move/verify step).
    ctx.resolvedContext[`${step.id}_output`] = primaryOutputPath;
  }

  await persistFlowRunInputs(ctx, ctx.args, ctx.args.inspectProviderScope);
}

async function runSteps(state: RunState): Promise<ExecuteStepsResult> {
  const { ctx, cursorIndex, steps, priorDecisions, priorErrors } = state;
  const { definition } = ctx;
  const args = ctx.args;

  const runStartedAt = Date.now();
  let outcome: FlowRunSummary['outcome'] = 'completed';
  let nextStepIndex = cursorIndex;
  let gateApprovalsThisRun = 0;
  const decisions = [...priorDecisions];
  const errors = [...priorErrors];

  if (nextStepIndex < definition.steps.length) {
    for (let index = nextStepIndex; index < definition.steps.length; index += 1) {
      const step = definition.steps[index];
      const stepState = steps[index];

      if (step.kind === 'gate') {
        const gateResult = await handleGateStep(step, stepState, ctx, decisions, gateApprovalsThisRun, index);
        if (gateResult.action === 'pause') {
          outcome = gateResult.outcome;
          nextStepIndex = gateResult.nextStepIndex;
          break;
        }
        gateApprovalsThisRun = gateResult.gateApprovalsThisRun;
        nextStepIndex = gateResult.nextStepIndex;
        continue;
      }

      stepState.startedAtUtc = nowIso();
      const stepStartedAt = Date.now();

      try {
        const result = await runTaskStep(step, index, ctx);
        const artifactPath = result.artifactPath ?? buildStepArtifactPath(ctx, index, step.id, 'json');

        if (!result.artifactPath) {
          await writeFile(artifactPath, `${JSON.stringify(result.output ?? {}, null, 2)}\n`, 'utf8');
        }

        if (!result.ok) {
          const problem = toProblemDetails(new Error(result.failureDetail), `/flow/${args.flowId}/${step.id}`);
          const classification = await recordStepFailure(stepState, problem, {
            stepId: step.id,
            startedAt: stepStartedAt,
            errorsPath: ctx.errorsPath,
            errors,
            artifactPath
          });
          outcome = classification === 'needs_data' ? 'needs_input' : 'failed';
          nextStepIndex = index;
          break;
        }

        await recordStepSuccess(result, step, stepState, ctx, artifactPath, stepStartedAt);

        nextStepIndex = index + 1;
        continue;
      } catch (error) {
        const problem =
          error instanceof FlowNeedsInputError
            ? toNeedsInputProblem(error, `/flow/${args.flowId}/${step.id}`)
            : toProblemDetails(error, `/flow/${args.flowId}/${step.id}`);
        const classification = await recordStepFailure(stepState, problem, {
          stepId: step.id,
          startedAt: stepStartedAt,
          errorsPath: ctx.errorsPath,
          errors
        });
        outcome = classification === 'needs_data' ? 'needs_input' : 'failed';
        nextStepIndex = index;
        break;
      }
    }
  }

  return { outcome, nextStepIndex, decisions, errors, durationMs: Date.now() - runStartedAt };
}

export async function runDeterministicFlow(args: RunDeterministicFlowArgs): Promise<FlowRunSummary> {
  const state = await initRunState(args);
  const { ctx, runId, initialStartedAtUtc, steps } = state;
  const { definition } = ctx;
  const runArgs = ctx.args;

  const execution = await runSteps(state);
  const { outcome, nextStepIndex, decisions, errors, durationMs } = execution;

  const summary = buildFlowRunSummary({
    runId,
    flowId: runArgs.flowId,
    resolvedFlowId: ctx.resolvedFlowId,
    mode: runArgs.mode,
    tenantId: runArgs.tenantId,
    bundleDir: ctx.bundleDir,
    manifestPath: ctx.manifestPath,
    inputsPath: ctx.inputsPath,
    decisionsPath: ctx.decisionsPath,
    errorsPath: ctx.errorsPath,
    watchFramesPath: ctx.watchFramesPath,
    startedAtUtc: initialStartedAtUtc,
    endedAtUtc: nowIso(),
    durationMs,
    ...(runArgs.resume ? { resumeFrom: runArgs.resume } : {}),
    outcome,
    ...(nextStepIndex < definition.steps.length
      ? { nextResumeStepId: definition.steps[nextStepIndex].id }
      : {}),
    ...(nextStepIndex < definition.steps.length
      ? {
          resumeCommand: `xyte-cli flow run ${runArgs.flowId} --tenant ${runArgs.tenantId} --${runArgs.mode} --inspect-provider-scope ${runArgs.inspectProviderScope} --resume ${runId}`
        }
      : {}),
    steps,
    decisions: computeDecisionCounts(decisions),
    classifications: computeClassificationCounts(errors),
    cursor: {
      nextStepIndex,
      ...(nextStepIndex < definition.steps.length ? { nextStepId: definition.steps[nextStepIndex].id } : {})
    }
  });

  await writeSummaryToManifest(summary, ctx.manifestPath);
  return summary;
}
