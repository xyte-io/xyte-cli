import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Command } from 'commander';

import { DEFAULT_WATCH_PROFILE, type WatchFrameV1, type WatchProfile } from '../../contracts/watch-frame';
import { CliUserError } from '../../contracts/user-error';
import { INSPECT_DEEP_DIVE_SCHEMA_VERSION } from '../../contracts/versions';
import { ensureParentDir } from '../../utils/fs';
import { errorMessage } from '../../utils/error-format';
import { isRecord } from '../../utils/json';
import { stringifyJsonOutput } from '../../utils/json-output';
import { type InspectProviderScope } from '../../types/settings-enums';
import { parseInspectProviderScope } from '../../utils/parse-domain';
import { TUI_SCREEN_IDS, type TuiScreenId } from '../../types/tui-screens';
import { runTuiApp } from '../../tui/app';
import {
  buildDeepDive,
  buildFleetInspect,
  collectFleetSnapshot,
  formatDeepDiveAscii,
  formatDeepDiveMarkdown,
  formatFleetInspectAscii
} from '../../workflows/fleet-insights';
import { generateOpsReport, parseReportInput } from '../../workflows/ops-report';
import { runWatch, WATCH_MIN_INTERVAL_MS, WATCH_MAX_POLLS } from '../../workflows/watch';
import type { SettingKey } from '../../config/settings';
import { parsePositiveIntegerOption, parseQueryJson } from '../parse-options';
import {
  type CliContext,
  type OutputFormat,
  type OutputStream,
  getExplicitGlobalOutput,
  parseCliOutputMode,
  printJson,
  requireTenantId,
  resolveStrictJson,
  resolveTextJsonOutput
} from '../cli-context';

function resolveOutPath(out: string | undefined): string | undefined {
  return out ? path.resolve(out) : undefined;
}

function writeRenderedOutput(stream: OutputStream, text: string, outPath?: string): void {
  stream.write(text);
  if (outPath) {
    ensureParentDir(outPath);
    writeFileSync(outPath, text, 'utf8');
  }
}

function appendRenderedOutput(stream: OutputStream, text: string, outPath?: string): void {
  stream.write(text);
  if (outPath) {
    ensureParentDir(outPath);
    appendFileSync(outPath, text, 'utf8');
  }
}

function resolveRenderMode<T extends string>(options: { render?: string }, allowed: readonly T[], fallback: T): T {
  const render = (options.render ?? fallback).trim().toLowerCase();
  if (!allowed.includes(render as T)) {
    throw new CliUserError({
      summary: `Invalid render mode: "${render}".`,
      suggestedCommands: allowed.map((mode) => `Use --render ${mode}`)
    });
  }
  return render as T;
}

function parseWatchProfile(value: string): WatchProfile {
  const normalized = value.trim().toLowerCase();
  if (normalized !== DEFAULT_WATCH_PROFILE) {
    throw new CliUserError({ summary: `Invalid watch profile: "${value}". Use ${DEFAULT_WATCH_PROFILE}.` });
  }
  return normalized as WatchProfile;
}

function parseWatchIntervalMs(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '2000', 10);
  if (!Number.isFinite(parsed)) {
    throw new CliUserError({ summary: `Invalid interval: "${value}".`, suggestedCommands: ['Use --interval <ms> with a positive integer'] });
  }
  if (parsed < WATCH_MIN_INTERVAL_MS) {
    throw new CliUserError({ summary: `Invalid interval: ${parsed}ms. Minimum is ${WATCH_MIN_INTERVAL_MS}ms.` });
  }
  return parsed;
}

function parseWatchMaxPolls(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new CliUserError({ summary: `Invalid max-polls: "${value}". Use a positive integer.` });
  }
  if (parsed > WATCH_MAX_POLLS) {
    throw new CliUserError({ summary: `Invalid max-polls: ${value}. Maximum is ${WATCH_MAX_POLLS}.` });
  }
  return parsed;
}

function stringifyWatchValue(value: unknown, fallback = '-'): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return fallback;
}

function formatWatchIncidentText(item: unknown): string {
  if (!isRecord(item)) {
    return stringifyWatchValue(item, 'Unknown incident');
  }

  const priority = stringifyWatchValue(item.priority, 'unknown').toUpperCase();
  const title = stringifyWatchValue(item.title ?? item.issue ?? item.id ?? item.uuid, 'Untitled incident');
  const device = stringifyWatchValue(item.device_name ?? item.device_id, 'unknown device');
  const space = stringifyWatchValue(item.space_tree_path_name ?? item.space_name, 'unknown space');
  return `[${priority}] ${title} | ${device} | ${space}`;
}

function formatWatchFrameText(frame: WatchFrameV1): string {
  const lines: string[] = [];
  const summary = frame.summary;

  if (frame.eventType === 'snapshot') {
    lines.push(`[snapshot] poll ${frame.pollIndex} | ${summary.total} active incidents`);
    const items = Array.isArray(frame.items) ? frame.items : [];
    if (items.length === 0) {
      lines.push('No active incidents.');
    } else {
      const preview = items.slice(0, 5);
      for (const item of preview) {
        lines.push(`- ${formatWatchIncidentText(item)}`);
      }
      if (items.length > preview.length) {
        lines.push(`... ${items.length - preview.length} more incidents`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  if (frame.eventType === 'heartbeat') {
    return `[heartbeat] poll ${frame.pollIndex} | no incident changes | ${summary.total} active incidents\n`;
  }

  if (frame.eventType === 'delta') {
    lines.push(
      `[delta] poll ${frame.pollIndex} | ${summary.total} active incidents | +${summary.added} -${summary.removed} ~${summary.updated}`
    );
    const previewEntries = [
      ...(frame.delta?.added ?? [])
        .slice(0, 3)
        .map((entry) => `+ ${formatWatchIncidentText(entry.after)}`),
      ...(frame.delta?.updated ?? [])
        .slice(0, 3)
        .map((entry) => `~ ${formatWatchIncidentText(entry.after)}`),
      ...(frame.delta?.removed ?? [])
        .slice(0, 3)
        .map((entry) => `- ${formatWatchIncidentText(entry.before ?? entry.id)}`)
    ];
    if (previewEntries.length === 0) {
      lines.push('No incident detail changes captured.');
    } else {
      lines.push(...previewEntries);
    }
    return `${lines.join('\n')}\n`;
  }

  if (frame.eventType === 'error') {
    const detail = frame.error?.detail ?? frame.error?.title ?? 'Watch failed.';
    return `[error] poll ${frame.pollIndex} | ${detail}\n`;
  }

  return `${JSON.stringify(frame)}\n`;
}

async function handleOpsWatchIncidents(
  ctx: CliContext,
  options: {
    tenant?: string;
    profile?: string;
    queryJson?: string;
    intervalMs?: string;
    maxPolls?: string;
    once?: boolean;
    output?: string;
    out?: string;
    strictJson?: boolean;
  },
  watchDelayFn?: (ms: number) => Promise<void>
): Promise<void> {
  const overrides: Partial<Record<SettingKey, unknown>> = {};
  if (options.tenant) {
    overrides['defaults.tenant'] = options.tenant;
  }
  if (options.profile) {
    overrides['watch.profile'] = parseWatchProfile(options.profile);
  }
  if (options.intervalMs) {
    overrides['watch.intervalMs'] = parseWatchIntervalMs(options.intervalMs);
  }
  if (options.maxPolls !== undefined) {
    overrides['watch.maxPolls'] = parseWatchMaxPolls(options.maxPolls);
  }
  const settings = await ctx.resolveSettings(overrides);
  const tenantId = options.tenant ?? settings.values.defaults.tenant;
  requireTenantId(tenantId, 'ops watch incidents');
  const query = parseQueryJson(options.queryJson);
  const output = resolveTextJsonOutput({
    output: options.output,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });
  const strictJson = resolveStrictJson({ strictJson: options.strictJson, settings });
  const outPath = resolveOutPath(options.out);
  let wroteOutPath = false;
  const client = await ctx.withClient({ tenantId, flagOverrides: overrides });
  await runWatch({
    client,
    tenantId,
    profile: settings.values.watch.profile,
    query,
    intervalMs: settings.values.watch.intervalMs,
    once: options.once === true,
    maxPolls: settings.values.watch.maxPolls,
    delayFn: watchDelayFn,
    onFrame: (frame) => {
      const renderFrame =
        output === 'text'
          ? formatWatchFrameText(frame)
          : `${stringifyJsonOutput(frame, { strictJson, compact: true })}\n`;
      if (outPath && !wroteOutPath) {
        writeRenderedOutput(ctx.stdout, renderFrame, outPath);
        wroteOutPath = true;
        return;
      }
      appendRenderedOutput(ctx.stdout, renderFrame, outPath);
    }
  });
}

async function setupAndCollectInspect(
  ctx: CliContext,
  options: {
    tenant?: string;
    providerScope?: string;
    commandLabel: string;
  }
) {
  const overrides: Partial<Record<SettingKey, unknown>> = {};
  if (options.tenant) {
    overrides['defaults.tenant'] = options.tenant;
  }
  if (options.providerScope) {
    overrides['ops.providerScope'] = parseInspectProviderScope(options.providerScope);
  }
  const settings = await ctx.resolveSettings(overrides);
  const tenantId = options.tenant ?? settings.values.defaults.tenant;
  requireTenantId(tenantId, options.commandLabel);
  const providerScope =
    (overrides['ops.providerScope'] as InspectProviderScope | undefined) ?? settings.values.ops.providerScope;
  const client = await ctx.withClient({ tenantId, flagOverrides: overrides });
  const tenantProfile = await ctx.profileStore.getTenant(tenantId);
  const snapshot = await collectFleetSnapshot({ client, tenantId, tenantName: tenantProfile?.name, providerScope });
  return { settings, snapshot };
}

async function handleOpsInspectFleet(
  ctx: CliContext,
  options: {
    tenant?: string;
    providerScope?: string;
    render?: string;
    output?: string;
    out?: string;
    strictJson?: boolean;
  }
): Promise<void> {
  const render = resolveRenderMode(options, ['json', 'ascii'], 'json');
  const { settings, snapshot } = await setupAndCollectInspect(ctx, {
    tenant: options.tenant,
    providerScope: options.providerScope,
    commandLabel: 'ops inspect fleet'
  });
  const result = buildFleetInspect(snapshot);
  const outPath = resolveOutPath(options.out);

  const output = resolveTextJsonOutput({
    output: options.output,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });
  if (render === 'ascii' || output === 'text') {
    writeRenderedOutput(ctx.stdout, `${formatFleetInspectAscii(result)}\n`, outPath);
    return;
  }
  writeRenderedOutput(
    ctx.stdout,
    `${stringifyJsonOutput(result, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) })}\n`,
    outPath
  );
}

async function handleOpsInspectDeepDive(
  ctx: CliContext,
  options: {
    tenant?: string;
    providerScope?: string;
    window?: string;
    render?: string;
    output?: string;
    out?: string;
    strictJson?: boolean;
  }
): Promise<void> {
  const render = resolveRenderMode(options, ['json', 'ascii', 'markdown'], 'json');
  const { settings, snapshot } = await setupAndCollectInspect(ctx, {
    tenant: options.tenant,
    providerScope: options.providerScope,
    commandLabel: 'ops inspect deep-dive'
  });
  const windowHours = Number.parseInt(options.window ?? '24', 10);
  const result = buildDeepDive(snapshot, Number.isFinite(windowHours) ? windowHours : 24);
  const outPath = resolveOutPath(options.out);

  if (render === 'ascii') {
    writeRenderedOutput(ctx.stdout, `${formatDeepDiveAscii(result)}\n`, outPath);
    return;
  }

  const output = resolveTextJsonOutput({
    output: options.output,
    stdoutIsTTY: ctx.stdoutIsTTY,
    settings
  });
  if (render === 'markdown' || output === 'text') {
    writeRenderedOutput(ctx.stdout, `${formatDeepDiveMarkdown(result, false)}\n`, outPath);
    return;
  }
  writeRenderedOutput(
    ctx.stdout,
    `${stringifyJsonOutput(result, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) })}\n`,
    outPath
  );
}

async function handleOpsReportGenerate(
  ctx: CliContext,
  options: {
    tenant?: string;
    input: string;
    out: string;
    render?: string;
    format?: string;
    includeSensitive?: boolean;
    strictJson?: boolean;
  }
): Promise<void> {
  const overrides: Partial<Record<SettingKey, unknown>> = {};
  if (options.tenant) {
    overrides['defaults.tenant'] = options.tenant;
  }
  if (options.includeSensitive === true) {
    overrides['report.includeSensitive'] = true;
  }
  const settings = await ctx.resolveSettings(overrides);
  const tenantId = options.tenant ?? settings.values.defaults.tenant;
  requireTenantId(tenantId, 'ops report generate');
  const inputPath = path.resolve(options.input);
  const inputHints = [
    'Generate fresh input with xyte-cli ops inspect deep-dive --output json',
    'Generate fresh input with xyte-cli util match',
    'Generate fresh input with xyte-cli util move-devices'
  ];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(inputPath, 'utf8')) as unknown;
  } catch (error) {
    const isSyntax = error instanceof SyntaxError;
    const detail = isSyntax ? `: ${error.message}` : `: ${errorMessage(error)}`;
    throw new CliUserError({
      summary: isSyntax ? `Input JSON is invalid${detail}` : `Cannot read input file${detail}`,
      detail: `Failed to ${isSyntax ? 'parse' : 'read'} ${inputPath}.`,
      suggestedCommands: inputHints
    });
  }

  let reportInput: ReturnType<typeof parseReportInput>;
  try {
    reportInput = parseReportInput(raw, tenantId);
  } catch (err) {
    if (err instanceof CliUserError) {
      throw new CliUserError({ ...err, suggestedCommands: [...(err.suggestedCommands ?? []), ...inputHints] });
    }
    throw new CliUserError({
      summary: err instanceof Error ? err.message : 'Invalid report input format.',
      suggestedCommands: inputHints
    });
  }
  if (reportInput.schemaVersion === INSPECT_DEEP_DIVE_SCHEMA_VERSION && !reportInput.tenantName) {
    const tenantProfile = await ctx.profileStore.getTenant(tenantId);
    if (tenantProfile?.name) {
      reportInput = {
        ...reportInput,
        tenantName: tenantProfile.name
      };
    }
  }
  const includeSensitive = options.includeSensitive === true || settings.values.report.includeSensitive;
  let generated: Awaited<ReturnType<typeof generateOpsReport>>;
  if (reportInput.schemaVersion === INSPECT_DEEP_DIVE_SCHEMA_VERSION) {
    const render = resolveRenderMode(options, ['markdown', 'pdf'], 'pdf');
    generated = await generateOpsReport({ input: reportInput, tenantId, format: render, outPath: options.out, includeSensitive });
  } else {
    const render = resolveRenderMode(options, ['markdown'], 'markdown');
    generated = await generateOpsReport({ input: reportInput, tenantId, format: render, outPath: options.out, includeSensitive });
  }
  printJson(ctx.stdout, generated, { strictJson: resolveStrictJson({ strictJson: options.strictJson, settings }) });
}

async function handleOpsConsole(
  ctx: CliContext,
  runTui: typeof runTuiApp,
  options: {
    headless?: boolean;
    screen?: string;
    output?: string;
    once?: boolean;
    follow?: boolean;
    intervalMs?: string;
    tenant?: string;
    motion?: boolean;
    debug?: boolean;
    debugLog?: string;
  }
): Promise<void> {
  const overrides: Partial<Record<SettingKey, unknown>> = {};
  if (options.tenant) {
    overrides['defaults.tenant'] = options.tenant;
  }
  if (options.motion === false) {
    overrides['console.motion'] = false;
  }
  if (options.follow === true) {
    overrides['console.follow'] = true;
  }
  if (options.intervalMs) {
    overrides['console.intervalMs'] = parsePositiveIntegerOption(options.intervalMs, 2000, 'interval-ms');
  }
  if (options.debugLog) {
    overrides['console.debugLogPath'] = options.debugLog;
  }
  const settings = await ctx.resolveSettings(overrides);
  const tenantId = options.tenant ?? settings.values.defaults.tenant;
  requireTenantId(tenantId, 'ops console');
  const secretStore = ctx.getSecretStore();
  const client = await ctx.withClient({
    tenantId,
    flagOverrides: overrides
  });
  const screenRaw = options.screen ?? settings.values.console.screen ?? 'dashboard';
  if (!(TUI_SCREEN_IDS as readonly string[]).includes(screenRaw)) {
    throw new CliUserError({
      summary: 'Invalid console screen.',
      detail: `Received "${screenRaw}".`,
      suggestedCommands: [`Use one of: ${TUI_SCREEN_IDS.join(', ')}`]
    });
  }
  const screen = screenRaw as TuiScreenId;
  const requestedOutput = parseCliOutputMode(
    options.output ?? (options.headless ? 'json' : undefined)
  );
  if (Boolean(options.headless) && requestedOutput && requestedOutput !== 'json') {
    throw new CliUserError({
      summary: 'Headless mode is JSON-only.',
      suggestedCommands: ['Use xyte-cli ops console --headless --output json']
    });
  }
  const follow = options.once ? false : (options.follow ?? settings.values.console.follow);
  const intervalMs = settings.values.console.intervalMs;
  const motionEnabled = options.motion === false ? false : settings.values.console.motion;

  await runTui({
    client,
    profileStore: ctx.profileStore,
    secretStore,
    initialScreen: screen,
    headless: Boolean(options.headless),
    format: (requestedOutput === 'text' ? 'text' : 'json') as OutputFormat,
    motionEnabled,
    follow,
    intervalMs,
    tenantId,
    output: ctx.stdout,
    debug: options.debug,
    debugLogPath: options.debugLog ?? settings.values.console.debugLogPath
  });
}

export function registerOpsCommands(
  parent: Command,
  ctx: CliContext,
  runTui: typeof runTuiApp = runTuiApp,
  watchDelayFn?: (ms: number) => Promise<void>
): void {
  const ops = parent.command('ops').description('Operator-focused console, watch, inspect, and report workflows');
  ops.addHelpText(
    'after',
    [
      '',
      'Examples:',
      '  xyte-cli ops watch incidents --tenant <tenant-id> --once',
      '  xyte-cli ops watch incidents --tenant <tenant-id> --once --output json --strict-json',
      '  xyte-cli ops inspect fleet --tenant <tenant-id> --output json',
      '  xyte-cli ops console --screen dashboard'
    ].join('\n')
  );
  const opsWatch = ops.command('watch').description('Watch operator-facing streams');
  opsWatch
    .command('incidents')
    .description('Watch active incidents as terminal text or JSON frames')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--profile <profile>', 'Watch profile override')
    .option('--query-json <json>', 'Query params JSON object (merged over defaults)')
    .option('--interval-ms <ms>', 'Polling interval in ms (minimum 1000)')
    .option('--max-polls <n>', 'Stop after N polls (maximum 3600)')
    .option('--once', 'Run one poll and exit')
    .option('--out <path>', 'Write the rendered output to a UTF-8 file')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: {
      tenant?: string;
      profile?: string;
      queryJson?: string;
      intervalMs?: string;
      maxPolls?: string;
      once?: boolean;
      out?: string;
      strictJson?: boolean;
    }) {
      await handleOpsWatchIncidents(ctx, {
        ...options,
        output: getExplicitGlobalOutput(this)
      }, watchDelayFn);
    });

  const opsInspect = ops.command('inspect').description('Deterministic fleet insights');
  opsInspect
    .command('fleet')
    .description('Build a fleet summary snapshot')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--provider-scope <scope>', 'organization|partner|auto')
    .option('--render <render>', 'Output format: json|ascii', 'json')
    .option('--format <format>', 'Alias for --render')
    .option('--out <path>', 'Write the rendered output to a UTF-8 file')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: {
      tenant?: string;
      providerScope?: string;
      render?: string;
      format?: string;
      out?: string;
      strictJson?: boolean;
    }) {
      await handleOpsInspectFleet(ctx, {
        ...options,
        render: options.format ?? options.render,
        output: getExplicitGlobalOutput(this)
      });
    });

  opsInspect
    .command('deep-dive')
    .description('Build deep-dive operational analytics')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--provider-scope <scope>', 'organization|partner|auto')
    .option('--window <hours>', 'Window in hours', '24')
    .option('--render <render>', 'Output format: json|ascii|markdown', 'json')
    .option('--format <format>', 'Alias for --render')
    .option('--out <path>', 'Write the rendered output to a UTF-8 file')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: {
      tenant?: string;
      providerScope?: string;
      window?: string;
      render?: string;
      format?: string;
      out?: string;
      strictJson?: boolean;
    }) {
      await handleOpsInspectDeepDive(ctx, {
        ...options,
        render: options.format ?? options.render,
        output: getExplicitGlobalOutput(this)
      });
    });

  const opsReport = ops.command('report').description('Generate reports from inspect outputs');
  opsReport
    .command('generate')
    .description('Generate report from inspect or migration JSON input')
    .requiredOption('--input <path>', 'Path to report input JSON')
    .requiredOption('--out <path>', 'Output path')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--render <render>', 'markdown|pdf')
    .option('--format <format>', 'Alias for --render')
    .option('--include-sensitive', 'Include full ticket/device IDs in report')
    .option('--strict-json', 'Fail on non-serializable output')
    .action(async function (options: {
      tenant?: string;
      input: string;
      out: string;
      render?: string;
      format?: string;
      includeSensitive?: boolean;
      strictJson?: boolean;
    }) {
      await handleOpsReportGenerate(ctx, { ...options, render: options.format ?? options.render });
    });

  ops
    .command('console')
    .description('Launch the interactive console or JSON-only headless mode')
    .option('--headless', 'Run headless visual mode for agents')
    .option('--screen <screen>', 'setup|config|dashboard|spaces|devices|incidents|tickets')
    .option('--once', 'Render one frame and exit (default behavior)')
    .option('--follow', 'Continuously stream frames')
    .option('--interval-ms <ms>', 'Polling interval for --follow')
    .option('--tenant <tenantId>', 'Tenant id override')
    .option('--no-motion', 'Disable motion and animation effects')
    .option('--debug', 'Enable TUI debug logging')
    .option('--debug-log <path>', 'Write TUI debug logs to this file')
    .action(async function (options: {
      headless?: boolean;
      screen?: string;
      once?: boolean;
      follow?: boolean;
      intervalMs?: string;
      tenant?: string;
      motion?: boolean;
      debug?: boolean;
      debugLog?: string;
    }) {
      await handleOpsConsole(ctx, runTui, {
        ...options,
        output: getExplicitGlobalOutput(this)
      });
    });
}
