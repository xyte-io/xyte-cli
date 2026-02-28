import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import path, { delimiter } from 'node:path';
import { randomUUID } from 'node:crypto';

import { buildCallEnvelope } from '../contracts/call-envelope';
import {
  buildFlowRunSummary,
  type FlowRunClassification,
  type FlowRunDecision,
  type FlowRunErrorEntry,
  type FlowRunStep,
  type FlowRunSummary
} from '../contracts/flow-run';
import { toProblemDetails } from '../contracts/problem';
import { buildStatusContract } from '../contracts/status';
import type { WatchFrameV1 } from '../contracts/watch-frame';
import { getEndpoint } from '../client/catalog';
import { evaluateReadiness } from '../config/readiness';
import type { ProfileStore } from '../secure/profile-store';
import type { SecretStore } from '../secure/secret-store';
import type { XyteClient } from '../types/client';
import { runWatch } from './watch';
import { buildUtilityPrepare } from './utility-prepare';
import { runSpaceImportTree } from './utility-commands';
import {
  buildDeepDive,
  buildFleetInspect,
  collectFleetSnapshot,
  generateFleetReport,
  type InspectProviderScope
} from './fleet-insights';
import type { BuiltInFlowDefinition, FlowStep, FlowTaskStep } from './flow-catalog';

export type FlowRunMode = 'plan' | 'apply';

class FlowNeedsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlowNeedsInputError';
  }
}

interface RunContext {
  args: RunDeterministicFlowArgs;
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

interface TaskExecutionResult {
  output?: unknown;
  artifactPath?: string;
  watchFrames?: WatchFrameV1[];
  contextUpdates?: Record<string, string>;
}

interface FlowRunInputsPayload {
  inspectProviderScope?: unknown;
}

export interface RunDeterministicFlowArgs {
  flowId: string;
  resolvedFlowId: string;
  definition: BuiltInFlowDefinition;
  tenantId: string;
  mode: FlowRunMode;
  allowWrite: boolean;
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

function isInspectProviderScopeError(error: unknown): boolean {
  return error instanceof Error && /inspect provider scope/i.test(error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

function sanitizeFlowId(flowId: string): string {
  return flowId.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function parseRunDirName(runId: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  return `${stamp}-${runId}`;
}

function parseVarEntries(values: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of values) {
    const index = entry.indexOf('=');
    if (index <= 0) {
      throw new Error(`Invalid --var entry: ${entry}. Use key=value.`);
    }
    const key = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    if (!key) {
      throw new Error(`Invalid --var entry: ${entry}. Key cannot be empty.`);
    }
    out[key] = value;
  }
  return out;
}

export function parseFlowVarOptions(values: string[] | undefined): Record<string, string> {
  return parseVarEntries(values ?? []);
}

function resolveTemplateString(input: string, context: Record<string, string>): string {
  return input.replace(/{{\s*([a-zA-Z0-9._-]+)\s*}}/g, (_all, rawKey: string) => {
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

function ensureContextKeys(step: FlowTaskStep, context: Record<string, string>): void {
  const required = step.requiresContext ?? [];
  const missing = required.filter((key) => !context[key]);
  if (missing.length > 0) {
    throw new FlowNeedsInputError(`Step ${step.id} requires context keys: ${missing.join(', ')}`);
  }
}

function resolveCommandFromPath(command: string, envPath = process.env.PATH ?? ''): string | undefined {
  const pathEntries = envPath.split(delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
          .map((ext) => ext.toLowerCase())
      : [''];

  for (const entry of pathEntries) {
    for (const ext of extensions) {
      const candidate = process.platform === 'win32' ? path.join(entry, `${command}${ext}`) : path.join(entry, command);
      if (!existsSync(candidate)) {
        continue;
      }
      try {
        accessSync(candidate, constants.X_OK);
      } catch {
        continue;
      }
      return candidate;
    }
  }

  return undefined;
}

function runInstallDoctorLite() {
  const expectedPath = path.resolve(__dirname, '../../dist/bin/xyte-cli.js');
  const commandPath = resolveCommandFromPath('xyte-cli');
  const commandOnPath = Boolean(commandPath);
  return {
    status: commandOnPath ? 'ok' : 'missing',
    commandOnPath,
    commandPath,
    expectedPath,
    sameTarget: commandPath ? path.resolve(commandPath).includes('xyte-cli') : false,
    suggestions: commandOnPath ? ['Global command wiring appears available.'] : ['Run: npm run install:global']
  };
}

function classifyFailure(problem: ReturnType<typeof toProblemDetails>): FlowRunClassification {
  const detail = `${problem.detail} ${JSON.stringify(problem.upstream ?? {})}`.toLowerCase();
  if (problem.status === 422 && (/valid command/.test(detail) || /friendly_name/.test(detail) || /no device found/.test(detail))) {
    return 'needs_data';
  }
  if (problem.xyteCode === 'XYTE_FLOW_NEEDS_INPUT') {
    return 'needs_data';
  }
  return 'bug';
}

function toNeedsInputProblem(error: FlowNeedsInputError, instance: string) {
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

function requiresWriteGuard(method: string): boolean {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function requiresDestructiveGuard(method: string): boolean {
  return method.toUpperCase() === 'DELETE';
}

function extractPrimaryOutputPath(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.outputPath === 'string') {
    return value.outputPath;
  }
  if (isRecord(value.artifacts) && typeof value.artifacts.primary === 'string') {
    return value.artifacts.primary;
  }
  if (typeof value.reportPath === 'string') {
    return value.reportPath;
  }
  return undefined;
}

async function runTaskStep(step: FlowTaskStep, stepIndex: number, ctx: RunContext): Promise<TaskExecutionResult> {
  ensureContextKeys(step, ctx.resolvedContext);

  switch (step.task) {
    case 'doctor.install': {
      return {
        output: runInstallDoctorLite()
      };
    }
    case 'setup.status': {
      const readiness = await evaluateReadiness({
        profileStore: ctx.args.profileStore,
        secretStore: ctx.args.secretStore,
        tenantId: ctx.args.tenantId,
        client: ctx.args.client,
        checkConnectivity: true
      });
      if (readiness.state !== 'ready') {
        throw new FlowNeedsInputError(`Setup status is ${readiness.state}. Run setup before continuing.`);
      }
      return {
        output: readiness
      };
    }
    case 'config.doctor': {
      const readiness = await evaluateReadiness({
        profileStore: ctx.args.profileStore,
        secretStore: ctx.args.secretStore,
        tenantId: ctx.args.tenantId,
        client: ctx.args.client,
        checkConnectivity: true
      });
      const payload = {
        retryAttempts: 2,
        retryBackoffMs: 250,
        readiness
      };
      if (readiness.connectionState !== 'connected') {
        throw new FlowNeedsInputError(`Connectivity is ${readiness.connectionState}. Resolve connectivity before continuing.`);
      }
      return {
        output: payload
      };
    }
    case 'status.fast': {
      const readiness = await evaluateReadiness({
        profileStore: ctx.args.profileStore,
        secretStore: ctx.args.secretStore,
        tenantId: ctx.args.tenantId,
        checkConnectivity: false
      });
      const payload = buildStatusContract({
        mode: 'fast',
        checkConnectivity: false,
        readiness
      });
      return {
        output: payload
      };
    }
    case 'inspect.fleet': {
      const tenantProfile = await ctx.args.profileStore.getTenant(ctx.args.tenantId);
      let snapshot;
      try {
        snapshot = await collectFleetSnapshot(
          ctx.args.client,
          ctx.args.tenantId,
          tenantProfile?.name,
          ctx.args.inspectProviderScope ?? 'auto'
        );
      } catch (error) {
        if (isInspectProviderScopeError(error)) {
          throw new FlowNeedsInputError((error as Error).message);
        }
        throw error;
      }
      const inspect = buildFleetInspect(snapshot);
      return {
        output: inspect
      };
    }
    case 'inspect.deep-dive': {
      const windowHours = step.inspect?.windowHours ?? 24;
      const tenantProfile = await ctx.args.profileStore.getTenant(ctx.args.tenantId);
      let snapshot;
      try {
        snapshot = await collectFleetSnapshot(
          ctx.args.client,
          ctx.args.tenantId,
          tenantProfile?.name,
          ctx.args.inspectProviderScope ?? 'auto'
        );
      } catch (error) {
        if (isInspectProviderScopeError(error)) {
          throw new FlowNeedsInputError((error as Error).message);
        }
        throw error;
      }
      const deepDive = buildDeepDive(snapshot, windowHours);
      return {
        output: deepDive
      };
    }
    case 'report.generate': {
      if (!step.report) {
        throw new Error(`Flow step ${step.id} is missing report configuration.`);
      }
      const input = ctx.taskOutputs.get(step.report.inputFromStepId);
      if (!isRecord(input) || input.schemaVersion !== 'xyte.inspect.deep-dive.v1') {
        throw new FlowNeedsInputError(
          `Step ${step.id} requires deep-dive output from ${step.report.inputFromStepId}.`
        );
      }
      const outPath = path.join(ctx.outputsDir, step.report.outFileName);
      const generated = await generateFleetReport({
        deepDive: input as any,
        format: step.report.format,
        outPath,
        includeSensitive: step.report.includeSensitive === true
      });
      return {
        output: generated,
        artifactPath: outPath
      };
    }
    case 'watch': {
      const watchConfig = step.watch;
      if (!watchConfig) {
        throw new Error(`Flow step ${step.id} is missing watch configuration.`);
      }
      const frames: WatchFrameV1[] = [];
      const once = ctx.args.once ? true : watchConfig.once;
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
      if (frames.length > 0) {
        await writeFile(watchStepPath, `${frames.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
      } else {
        await writeFile(watchStepPath, '', 'utf8');
      }

      return {
        output: {
          frameCount: frames.length,
          lastEventType: frames.length > 0 ? frames[frames.length - 1].eventType : undefined
        },
        artifactPath: watchStepPath,
        watchFrames: frames,
        contextUpdates:
          frames.length > 0 && Array.isArray(frames[0].items) && frames[0].items.length > 0 && isRecord(frames[0].items[0])
            ? {
                ...(typeof frames[0].items[0].device_id === 'string' ? { watch_device_id: String(frames[0].items[0].device_id) } : {}),
                ...(typeof frames[0].items[0].uuid === 'string' ? { watch_incident_id: String(frames[0].items[0].uuid) } : {}),
                ...(typeof frames[0].items[0].id === 'string' ? { watch_item_id: String(frames[0].items[0].id) } : {})
              }
            : undefined
      };
    }
    case 'call': {
      if (!step.call) {
        throw new Error(`Flow step ${step.id} is missing call configuration.`);
      }

      const endpoint = getEndpoint(step.call.endpointKey);
      const method = endpoint.method.toUpperCase();
      const isWrite = requiresWriteGuard(method);
      if (isWrite && !ctx.args.allowWrite) {
        throw new FlowNeedsInputError(`Step ${step.id} is mutating. Re-run with --apply --allow-write.`);
      }
      if (requiresDestructiveGuard(method)) {
        const requiredConfirm = step.call.confirm ?? step.call.endpointKey;
        if (requiredConfirm !== step.call.endpointKey) {
          throw new Error(`Step ${step.id} has invalid destructive confirm token.`);
        }
      }

      const pathPayload = step.call.path ? resolveTemplateValue(step.call.path, ctx.resolvedContext) : undefined;
      const queryPayload = step.call.query ? resolveTemplateValue(step.call.query, ctx.resolvedContext) : undefined;
      const bodyPayload = step.call.body ? resolveTemplateValue(step.call.body, ctx.resolvedContext) : undefined;

      const result = await ctx.args.client.callWithMeta(step.call.endpointKey, {
        tenantId: ctx.args.tenantId,
        ...(pathPayload ? { path: pathPayload as Record<string, string | number> } : {}),
        ...(queryPayload ? { query: queryPayload as Record<string, string | number | boolean | null | undefined> } : {}),
        ...(bodyPayload !== undefined ? { body: bodyPayload } : {})
      });

      const envelope = buildCallEnvelope({
        requestId: randomUUID(),
        tenantId: ctx.args.tenantId,
        endpointKey: step.call.endpointKey,
        method,
        guard: {
          allowWrite: isWrite,
          ...(requiresDestructiveGuard(method) ? { confirm: step.call.endpointKey } : {})
        },
        request: {
          path: pathPayload as any,
          query: queryPayload as any,
          body: bodyPayload
        },
        response: {
          status: result.status,
          durationMs: result.durationMs,
          retryCount: result.retryCount,
          data: result.data
        }
      });

      const contextUpdates: Record<string, string> = {};
      if (step.call.endpointKey === 'organization.commands.getCommands' && isRecord(result.data)) {
        const items = Array.isArray(result.data.items) ? result.data.items : [];
        const first = items.find((item) => isRecord(item) && typeof item.command === 'string');
        if (first && typeof first.command === 'string') {
          contextUpdates.command = first.command;
        }
      }

      return {
        output: envelope,
        contextUpdates: Object.keys(contextUpdates).length > 0 ? contextUpdates : undefined
      };
    }
    case 'utility.prepare': {
      if (!step.utilityPrepare) {
        throw new Error(`Flow step ${step.id} is missing utility prepare configuration.`);
      }
      const inputPath = path.resolve(resolveTemplateString(step.utilityPrepare.inputPath, ctx.resolvedContext));
      const outputDir = path.join(ctx.outputsDir, path.basename(step.utilityPrepare.outputDir));
      const result = buildUtilityPrepare({
        inputPath,
        actionKey: step.utilityPrepare.actionKey,
        outputDir,
        tenantId: ctx.args.tenantId,
        primaryFormat: step.utilityPrepare.primaryFormat,
        force: true
      });
      const contextUpdates: Record<string, string> = {};
      if (step.utilityPrepare.actionKey === 'space.import-tree') {
        contextUpdates.space_import_tree_csv = result.artifacts.primary;
      }
      if (step.utilityPrepare.actionKey === 'organization.devices.claimDevice') {
        contextUpdates.claim_prepare_csv = result.artifacts.primary;
      }
      return {
        output: result,
        contextUpdates
      };
    }
    case 'space.import-tree': {
      if (!step.spaceImportTree) {
        throw new Error(`Flow step ${step.id} is missing space import configuration.`);
      }
      if (step.spaceImportTree.apply && !ctx.args.allowWrite) {
        throw new FlowNeedsInputError(`Step ${step.id} applies changes. Re-run with --apply --allow-write.`);
      }

      const inputPath = path.resolve(resolveTemplateString(step.spaceImportTree.inputPath, ctx.resolvedContext));
      const reportPath = path.join(ctx.outputsDir, path.basename(step.spaceImportTree.reportPath));
      const result = await runSpaceImportTree({
        client: ctx.args.client,
        tenantId: ctx.args.tenantId,
        inputPath,
        apply: step.spaceImportTree.apply,
        continueOnError: false,
        reportPath
      });
      return {
        output: result,
        artifactPath: reportPath
      };
    }
    default: {
      throw new Error(`Unsupported flow task type: ${(step as { task: string }).task}`);
    }
  }
}

function computeDecisionCounts(decisions: FlowRunDecision[]) {
  return {
    pending: decisions.filter((item) => item.action === 'pending').length,
    approved: decisions.filter((item) => item.action === 'approved').length,
    blocked: decisions.filter((item) => item.action === 'blocked').length
  };
}

function computeClassificationCounts(errors: FlowRunErrorEntry[]) {
  return {
    needs_data: errors.filter((item) => item.classification === 'needs_data').length,
    bug: errors.filter((item) => item.classification === 'bug').length
  };
}

async function findRunBundle(outDir: string, resumeRef: string): Promise<string> {
  if (!resumeRef.trim()) {
    throw new Error('Invalid --resume value.');
  }

  const direct = path.resolve(resumeRef);
  if (existsSync(path.join(direct, 'manifest.json'))) {
    return direct;
  }

  const root = path.resolve(outDir);
  const flowDirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const flowDir of flowDirs) {
    if (!flowDir.isDirectory()) {
      continue;
    }
    const runDirs = await readdir(path.join(root, flowDir.name), { withFileTypes: true }).catch(() => []);
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
      } catch {
        // ignore malformed manifests during search
      }
    }
  }

  throw new Error(`Unable to resolve resume run: ${resumeRef}`);
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

async function readLinesAsJson<T>(filePath: string): Promise<T[]> {
  if (!existsSync(filePath)) {
    return [];
  }
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function isInspectProviderScopeValue(value: unknown): value is InspectProviderScope {
  return value === 'auto' || value === 'organization' || value === 'partner';
}

async function readStoredInspectProviderScope(bundleDir: string): Promise<InspectProviderScope | undefined> {
  const inputsPath = path.join(bundleDir, 'inputs.json');
  if (!existsSync(inputsPath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(await readFile(inputsPath, 'utf8')) as FlowRunInputsPayload;
    if (isInspectProviderScopeValue(parsed.inspectProviderScope)) {
      return parsed.inspectProviderScope;
    }
  } catch {
    // Ignore malformed resume inputs and use current invocation defaults.
  }

  return undefined;
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
    } catch {
      // Ignore malformed task artifacts during resume hydration.
    }
  }
  return taskOutputs;
}

async function writeSummaryToManifest(summary: FlowRunSummary, manifestPath: string): Promise<void> {
  await writeFile(manifestPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

export async function runDeterministicFlow(args: RunDeterministicFlowArgs): Promise<FlowRunSummary> {
  const outRoot = path.resolve(args.outDir);
  const resumeBundle = args.resume ? await findRunBundle(outRoot, args.resume) : undefined;

  let runId: string = randomUUID();
  let bundleDir = path.join(outRoot, sanitizeFlowId(args.flowId), parseRunDirName(runId));
  let initialStartedAtUtc = nowIso();
  let steps = createInitialSteps(args.definition);
  let cursorIndex = 0;
  let priorDecisions: FlowRunDecision[] = [];
  let priorErrors: FlowRunErrorEntry[] = [];
  let resumedInspectProviderScope: InspectProviderScope | undefined;

  if (resumeBundle) {
    const manifestPath = path.join(resumeBundle, 'manifest.json');
    const existingSummary = JSON.parse(await readFile(manifestPath, 'utf8')) as FlowRunSummary;
    runId = existingSummary.runId;
    bundleDir = resumeBundle;
    initialStartedAtUtc = existingSummary.startedAtUtc;
    steps = existingSummary.steps;
    cursorIndex = existingSummary.cursor.nextStepIndex;
    priorDecisions = await readLinesAsJson<FlowRunDecision>(path.join(resumeBundle, 'decisions.ndjson'));
    priorErrors = await readLinesAsJson<FlowRunErrorEntry>(path.join(resumeBundle, 'errors.ndjson'));
    resumedInspectProviderScope = await readStoredInspectProviderScope(resumeBundle);
  }

  const effectiveInspectProviderScope = args.inspectProviderScope ?? resumedInspectProviderScope ?? 'auto';
  const restoredTaskOutputs = resumeBundle ? await restoreTaskOutputsFromSteps(steps) : new Map<string, unknown>();
  const ctx: RunContext = {
    args: {
      ...args,
      inspectProviderScope: effectiveInspectProviderScope
    },
    bundleDir,
    stepsDir: path.join(bundleDir, 'steps'),
    outputsDir: path.join(bundleDir, 'outputs'),
    manifestPath: path.join(bundleDir, 'manifest.json'),
    inputsPath: path.join(bundleDir, 'inputs.json'),
    decisionsPath: path.join(bundleDir, 'decisions.ndjson'),
    errorsPath: path.join(bundleDir, 'errors.ndjson'),
    watchFramesPath: path.join(bundleDir, 'watch-frames.ndjson'),
    resolvedContext: {
      ...args.context
    },
    taskOutputs: restoredTaskOutputs
  };

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

  await writeFile(
    ctx.inputsPath,
    `${JSON.stringify(
      {
        flowId: args.flowId,
        resolvedFlowId: args.resolvedFlowId,
        tenantId: args.tenantId,
        mode: args.mode,
        allowWrite: args.allowWrite,
        inspectProviderScope: effectiveInspectProviderScope,
        context: ctx.resolvedContext,
        resume: args.resume,
        strictJson: args.strictJson,
        once: args.once,
        generatedAtUtc: nowIso()
      },
      null,
      2
    )}\n`,
    'utf8'
  );

  const runStartedAt = Date.now();
  let outcome: FlowRunSummary['outcome'] = 'completed';
  let nextStepIndex = cursorIndex;
  let gateApprovalsThisRun = 0;
  const decisions = [...priorDecisions];
  const errors = [...priorErrors];

  if (nextStepIndex >= args.definition.steps.length) {
    outcome = 'completed';
  } else {
    for (let index = nextStepIndex; index < args.definition.steps.length; index += 1) {
      const step = args.definition.steps[index];
      const stepState = steps[index];

      if (step.kind === 'gate') {
        if (args.mode === 'plan') {
          stepState.status = 'gate_pending';
          const decision: FlowRunDecision = {
            timestamp: nowIso(),
            stepId: step.id,
            action: 'pending',
            detail: 'Plan mode paused at human decision gate.',
            requiresWrite: step.mutating
          };
          decisions.push(decision);
          await appendNdjson(ctx.decisionsPath, decision);
          outcome = 'pending_gate';
          nextStepIndex = index;
          break;
        }

        if (step.mutating && !args.allowWrite) {
          stepState.status = 'gate_pending';
          const decision: FlowRunDecision = {
            timestamp: nowIso(),
            stepId: step.id,
            action: 'blocked',
            detail: 'Mutating gate requires --allow-write.',
            requiresWrite: true
          };
          decisions.push(decision);
          await appendNdjson(ctx.decisionsPath, decision);
          outcome = 'pending_gate';
          nextStepIndex = index;
          break;
        }

        if (gateApprovalsThisRun >= 1) {
          stepState.status = 'gate_pending';
          const decision: FlowRunDecision = {
            timestamp: nowIso(),
            stepId: step.id,
            action: 'pending',
            detail: 'Single-gate apply limit reached for this invocation.',
            requiresWrite: step.mutating
          };
          decisions.push(decision);
          await appendNdjson(ctx.decisionsPath, decision);
          outcome = 'pending_gate';
          nextStepIndex = index;
          break;
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
        gateApprovalsThisRun += 1;
        nextStepIndex = index + 1;
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

        stepState.status = 'completed';
        stepState.endedAtUtc = nowIso();
        stepState.durationMs = Date.now() - stepStartedAt;
        stepState.artifactPath = artifactPath;

        if (result.watchFrames && result.watchFrames.length > 0) {
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

        const primaryOutputPath = extractPrimaryOutputPath(result.output);
        if (primaryOutputPath) {
          ctx.resolvedContext[`${step.id}_output`] = primaryOutputPath;
        }

        nextStepIndex = index + 1;
        continue;
      } catch (error) {
        const problem =
          error instanceof FlowNeedsInputError
            ? toNeedsInputProblem(error, `/flow/${args.flowId}/${step.id}`)
            : toProblemDetails(error, `/flow/${args.flowId}/${step.id}`);
        const classification = classifyFailure(problem);

        stepState.status = 'failed';
        stepState.endedAtUtc = nowIso();
        stepState.durationMs = Date.now() - stepStartedAt;
        stepState.error = problem;
        stepState.classification = classification;

        const errorEntry: FlowRunErrorEntry = {
          timestamp: nowIso(),
          stepId: step.id,
          classification,
          error: problem
        };
        errors.push(errorEntry);
        await appendNdjson(ctx.errorsPath, errorEntry);

        outcome = classification === 'needs_data' ? 'needs_input' : 'failed';
        nextStepIndex = index;
        break;
      }
    }
  }

  if (outcome === 'completed' && nextStepIndex < args.definition.steps.length) {
    outcome = 'pending_gate';
  }

  const decisionsCount = computeDecisionCounts(decisions);
  const classificationCount = computeClassificationCounts(errors);

  const summary = buildFlowRunSummary({
    runId,
    flowId: args.flowId,
    resolvedFlowId: args.resolvedFlowId,
    mode: args.mode,
    tenantId: args.tenantId,
    bundleDir: ctx.bundleDir,
    manifestPath: ctx.manifestPath,
    inputsPath: ctx.inputsPath,
    decisionsPath: ctx.decisionsPath,
    errorsPath: ctx.errorsPath,
    watchFramesPath: ctx.watchFramesPath,
    startedAtUtc: initialStartedAtUtc,
    endedAtUtc: nowIso(),
    durationMs: Date.now() - runStartedAt,
    ...(args.resume ? { resumeFrom: args.resume } : {}),
    outcome,
    ...(nextStepIndex < args.definition.steps.length ? { nextResumeStepId: args.definition.steps[nextStepIndex].id } : {}),
    ...(nextStepIndex < args.definition.steps.length
      ? {
          resumeCommand: `xyte-cli flow run ${args.flowId} --tenant ${args.tenantId} --apply --allow-write --inspect-provider-scope ${effectiveInspectProviderScope} --resume ${runId}`
        }
      : {}),
    steps,
    decisions: decisionsCount,
    classifications: classificationCount,
    cursor: {
      nextStepIndex,
      ...(nextStepIndex < args.definition.steps.length ? { nextStepId: args.definition.steps[nextStepIndex].id } : {})
    }
  });

  await writeSummaryToManifest(summary, ctx.manifestPath);
  return summary;
}
