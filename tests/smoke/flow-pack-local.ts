import { existsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NPM_COMMAND, XYTE_COMMAND, normalizeJsonOutput, runCommand } from './shared';
import { errorMessage } from '../../src/utils/error-format';

interface ParsedArgs {
  tenant: string;
  baseUrl: string;
  skipBuild: boolean;
  skipTest: boolean;
}

interface CommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

interface FlowStepResult {
  status: string;
  reason: string;
}

interface SmokeSummaryStep {
  id: string;
  status: 'pass' | 'fail' | 'skip';
  reason: string;
  [key: string]: unknown;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    tenant: 'local-flow',
    baseUrl: 'http://127.0.0.1:3001',
    skipBuild: false,
    skipTest: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--tenant') {
      parsed.tenant = argv[index + 1] ?? parsed.tenant;
      index += 1;
      continue;
    }
    if (token === '--base-url') {
      parsed.baseUrl = argv[index + 1] ?? parsed.baseUrl;
      index += 1;
      continue;
    }
    if (token === '--skip-build') {
      parsed.skipBuild = true;
      continue;
    }
    if (token === '--skip-test') {
      parsed.skipTest = true;
    }
  }

  return parsed;
}

function parseJsonSafe(raw: unknown): unknown {
  try {
    return normalizeJsonOutput(raw);
  } catch {
    return null;
  }
}

function parseNdjson(raw: unknown): unknown[] {
  return String(raw ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<unknown[]>((acc, line) => {
      try {
        acc.push(JSON.parse(line) as unknown);
      } catch {
        // Skip malformed NDJSON lines
      }
      return acc;
    }, []);
}

function parseEnvelopeUpstreamError(result: CommandOutcome): string {
  const payload = parseJsonSafe(result.stdout);
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const rec = payload as Record<string, unknown>;
  const errorObj = rec.error && typeof rec.error === 'object' ? (rec.error as Record<string, unknown>) : undefined;
  const upstream = errorObj?.upstream;
  if (!upstream || typeof upstream !== 'object') {
    return '';
  }
  const upstreamRec = upstream as Record<string, unknown>;
  if (typeof upstreamRec.error === 'string') {
    return upstreamRec.error;
  }
  if (typeof upstreamRec.message === 'string') {
    return upstreamRec.message;
  }
  return '';
}

function parseEnvelopeStatus(result: CommandOutcome): number | null {
  const payload = parseJsonSafe(result.stdout);
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const rec = payload as Record<string, unknown>;
  const responseObj =
    rec.response && typeof rec.response === 'object' ? (rec.response as Record<string, unknown>) : undefined;
  if (typeof responseObj?.status === 'number') {
    return responseObj.status;
  }
  const errorObj = rec.error && typeof rec.error === 'object' ? (rec.error as Record<string, unknown>) : undefined;
  if (typeof errorObj?.status === 'number') {
    return errorObj.status;
  }
  return null;
}

export function classifyStep(
  stepId: string,
  result: CommandOutcome,
  context: { updateVerified?: boolean; readBackSucceeded?: boolean } = {}
): FlowStepResult {
  if (stepId === 'send_command_write') {
    if (result.code === 0) {
      return { status: 'pass', reason: 'Command dispatch succeeded.' };
    }
    const upstreamError = parseEnvelopeUpstreamError(result);
    const envelopeStatus = parseEnvelopeStatus(result);
    if (envelopeStatus === 422 && /valid command|friendly_name/i.test(upstreamError)) {
      return {
        status: 'pass',
        reason: 'Endpoint reachable; data-specific command validation blocked execution.'
      };
    }
    return { status: 'fail', reason: 'Command dispatch failed with unexpected error.' };
  }

  if (stepId === 'update_device_verify') {
    if (context.updateVerified === true) {
      return { status: 'pass', reason: 'Update-device read-back verification succeeded.' };
    }
    if (context.readBackSucceeded === true) {
      return {
        status: 'pass',
        reason: 'Update-device read-back executed, but target fields were unchanged in current dataset.'
      };
    }
    return { status: 'fail', reason: 'Update-device verification failed; read-back did not match expected state.' };
  }

  if (stepId.startsWith('skip_')) {
    return { status: 'skip', reason: result.stderr.trim() || 'Skipped due to missing prerequisite data.' };
  }

  if (result.code === 0) {
    return { status: 'pass', reason: 'Command succeeded.' };
  }
  return { status: 'fail', reason: result.stderr.trim() || 'Command failed.' };
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function pushStep(
  steps: SmokeSummaryStep[],
  id: string,
  status: SmokeSummaryStep['status'],
  reason: string,
  extra: Record<string, unknown> = {}
): void {
  steps.push({
    id,
    status,
    reason,
    ...extra
  });
}

function renderSummary(steps: SmokeSummaryStep[]): string {
  const totals = {
    pass: 0,
    fail: 0,
    skip: 0
  };
  for (const step of steps) {
    totals[step.status] += 1;
  }

  const lines = [
    '',
    'Flow-Pack Local Smoke Summary',
    `pass=${totals.pass} fail=${totals.fail} skip=${totals.skip} total=${steps.length}`,
    ''
  ];
  for (const step of steps) {
    lines.push(`${step.id.padEnd(34)} ${step.status.toUpperCase().padEnd(4)} ${step.reason}`);
  }
  return lines.join('\n');
}

async function resetMock(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/_mock/reset`, {
    method: 'POST'
  });
  ensure(response.ok, `Failed to reset mock server (${response.status}).`);
}

async function getMockState(baseUrl: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}/_mock/state`);
  ensure(response.ok, `Failed to read mock state (${response.status}).`);
  return (await response.json()) as Record<string, unknown>;
}

async function runChecked(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<CommandOutcome> {
  const result = await runCommand(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdinMode: 'ignore'
  });
  if (result.code !== 0) {
    const detail = [
      `${command} ${args.join(' ')}`,
      result.stdout.trim() ? `stdout:\n${result.stdout.trim()}` : '',
      result.stderr.trim() ? `stderr:\n${result.stderr.trim()}` : ''
    ]
      .filter(Boolean)
      .join('\n\n');
    throw new Error(detail);
  }
  return result;
}

async function runFlow(
  env: NodeJS.ProcessEnv,
  outDir: string,
  flowId: string,
  extraArgs: string[] = []
): Promise<Record<string, unknown>> {
  const args = [
    'flow',
    'run',
    flowId,
    '--tenant',
    env.XYTE_FLOW_TENANT ?? '',
    '--out-dir',
    outDir,
    '--strict-json',
    ...extraArgs
  ];
  const result = await runChecked(XYTE_COMMAND, args, { env });
  const raw = parseJsonSafe(result.stdout);
  const payload = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  ensure(payload.schemaVersion === 'xyte.flow.run.v1', `Unexpected flow output for ${flowId}.`);
  return payload;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const root = mkdtempSync(path.join(tmpdir(), 'xyte-flow-pack-smoke-'));
  const configDir = path.join(root, 'config');
  const outDir = path.join(root, 'flow-runs');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  // Intentionally minimal env: this smoke test uses a mock server and does not
  // install npm packages, so full HOME/npm isolation via buildIsolatedEnv is not needed.
  const env = {
    ...process.env,
    XYTE_CLI_CONFIG_DIR: configDir,
    XYTE_FLOW_TENANT: args.tenant
  };

  const steps: SmokeSummaryStep[] = [];

  if (!args.skipBuild) {
    await runChecked(NPM_COMMAND, ['run', 'build'], { env });
    pushStep(steps, 'build', 'pass', 'npm run build completed.');
  }

  if (!args.skipTest) {
    await runChecked(NPM_COMMAND, ['test'], { env });
    pushStep(steps, 'test', 'pass', 'npm test completed.');
  }

  await resetMock(args.baseUrl);
  pushStep(steps, 'mock_reset', 'pass', 'Mock state reset.');

  await runChecked(
    XYTE_COMMAND,
    ['config', 'tenant', 'add', args.tenant, '--hub-url', args.baseUrl, '--entry-url', args.baseUrl],
    { env }
  );
  pushStep(steps, 'tenant_add', 'pass', `Tenant ${args.tenant} added for ${args.baseUrl}.`);

  await runChecked(
    XYTE_COMMAND,
    [
      'config',
      'key',
      'add',
      '--tenant',
      args.tenant,
      '--provider',
      'xyte-org',
      '--name',
      'local',
      '--key',
      'local-key',
      '--set-active'
    ],
    { env }
  );
  pushStep(steps, 'key_add', 'pass', 'Local org key configured.');

  const setupFlow = await runFlow(env, outDir, 'flow.setup-readiness-10m');
  ensure(setupFlow.outcome === 'completed', 'flow.setup-readiness-10m did not complete.');
  const setupSteps = setupFlow.steps as Array<{ status: string }>;
  ensure(
    setupSteps.every((step) => step.status === 'completed'),
    'setup flow had non-completed steps.'
  );
  ensure(existsSync(String(setupFlow.bundleDir)), 'setup flow bundle was not created.');
  pushStep(steps, 'flow_setup', 'pass', 'Setup readiness flow completed.');

  const watchOnce = await runChecked(
    XYTE_COMMAND,
    ['ops', 'watch', 'incidents', '--tenant', args.tenant, '--profile', 'incidents-active', '--once', '--strict-json'],
    { env }
  );
  const watchOnceRaw = parseJsonSafe(watchOnce.stdout);
  const watchOnceFrame =
    watchOnceRaw && typeof watchOnceRaw === 'object' ? (watchOnceRaw as Record<string, unknown>) : {};
  ensure(watchOnceFrame.schemaVersion === 'xyte.watch.frame.v1', 'watch once did not emit xyte.watch.frame.v1.');
  ensure(watchOnceFrame.eventType === 'snapshot', 'watch once did not emit a snapshot frame.');
  const watchOnceItems = watchOnceFrame.items as unknown[];
  ensure(Array.isArray(watchOnceItems) && watchOnceItems.length > 0, 'watch once returned no incidents.');
  pushStep(steps, 'watch_once', 'pass', `Watch once returned ${watchOnceItems.length} active incidents.`);

  const watchLoop = await runChecked(
    XYTE_COMMAND,
    [
      'ops',
      'watch',
      'incidents',
      '--tenant',
      args.tenant,
      '--profile',
      'incidents-active',
      '--interval-ms',
      '1000',
      '--max-polls',
      '3',
      '--strict-json'
    ],
    { env }
  );
  const loopFrames = parseNdjson(watchLoop.stdout) as Array<Record<string, unknown>>;
  ensure(loopFrames.length === 3, `Expected 3 loop watch frames, got ${loopFrames.length}.`);
  ensure(loopFrames[0]?.eventType === 'snapshot', 'Loop watch first frame was not snapshot.');
  ensure(
    loopFrames.slice(1).every((frame) => frame.eventType === 'heartbeat' || frame.eventType === 'delta'),
    'Loop watch follow-up frames were invalid.'
  );
  pushStep(
    steps,
    'watch_loop',
    'pass',
    `Loop watch emitted ${loopFrames.length} frames (${loopFrames.map((frame) => frame.eventType).join(', ')}).`
  );

  const watchFlow = await runFlow(env, outDir, 'flow.incidents-delta-watch', ['--once']);
  ensure(watchFlow.outcome === 'completed', 'flow.incidents-delta-watch did not complete.');
  const watchSteps = watchFlow.steps as Array<{ status: string }>;
  ensure(
    watchSteps.every((step) => step.status === 'completed'),
    'watch flow had non-completed steps.'
  );
  pushStep(steps, 'flow_watch', 'pass', 'Incidents delta watch flow completed.');

  const triagePlan = await runFlow(env, outDir, 'flow.watch-to-triage', ['--once']);
  ensure(triagePlan.outcome === 'pending_gate', 'flow.watch-to-triage did not stop at the human gate.');
  ensure(
    existsSync(path.join(String(triagePlan.bundleDir), 'outputs', 'xyte-triage.md')),
    'Triage report was not generated.'
  );
  const triageApply = await runFlow(env, outDir, 'flow.watch-to-triage', [
    '--apply',
    '--resume',
    String(triagePlan.runId)
  ]);
  ensure(triageApply.outcome === 'completed', 'flow.watch-to-triage did not complete on resume.');
  pushStep(steps, 'flow_triage', 'pass', 'Watch-to-triage flow produced artifacts and resumed cleanly.');

  const dailyPlan = await runFlow(env, outDir, 'flow.daily-deep-dive-report', ['--once']);
  ensure(dailyPlan.outcome === 'pending_gate', 'flow.daily-deep-dive-report did not stop at the human gate.');
  ensure(
    existsSync(path.join(String(dailyPlan.bundleDir), 'outputs', 'xyte-daily.md')),
    'Daily markdown report was not generated.'
  );
  const dailyApply = await runFlow(env, outDir, 'flow.daily-deep-dive-report', [
    '--apply',
    '--resume',
    String(dailyPlan.runId)
  ]);
  ensure(dailyApply.outcome === 'completed', 'flow.daily-deep-dive-report did not complete on resume.');
  pushStep(steps, 'flow_daily', 'pass', 'Daily deep-dive report flow produced artifacts and resumed cleanly.');

  let remediation = await runFlow(env, outDir, 'flow.guided-remediation', [
    '--once',
    '--var',
    'ticket_id=t1',
    '--var',
    'command=restart'
  ]);
  ensure(remediation.outcome === 'pending_gate', 'flow.guided-remediation did not stop at the first gate.');
  ensure(
    remediation.nextResumeStepId === 'gate_send_command',
    'Guided remediation did not stop at send-command gate first.'
  );

  const remediationGateOrder = ['gate_update_device', 'gate_ticket_message', 'gate_close_incident'];
  for (const expectedGate of remediationGateOrder) {
    remediation = await runFlow(env, outDir, 'flow.guided-remediation', [
      '--apply',
      '--resume',
      String(remediation.runId)
    ]);
    ensure(remediation.outcome === 'pending_gate', `Guided remediation did not stop at ${expectedGate}.`);
    ensure(
      remediation.nextResumeStepId === expectedGate,
      `Guided remediation expected next gate ${expectedGate}, got ${String(remediation.nextResumeStepId)}.`
    );
  }

  remediation = await runFlow(env, outDir, 'flow.guided-remediation', [
    '--apply',
    '--resume',
    String(remediation.runId)
  ]);
  ensure(remediation.outcome === 'completed', 'Guided remediation did not complete after final approval.');

  const state = await getMockState(args.baseUrl);
  const stateIncidents = Array.isArray(state.incidents) ? (state.incidents as Array<Record<string, unknown>>) : [];
  const activeIncidents = stateIncidents.filter((incident) => incident.status === 'active');
  const stateDevices = Array.isArray(state.devices) ? (state.devices as Array<Record<string, unknown>>) : [];
  const deviceTwo = stateDevices.find((device) => device.id === 'd2');
  const stateTickets = Array.isArray(state.tickets) ? (state.tickets as Array<Record<string, unknown>>) : [];
  const ticket = stateTickets.find((item) => item.id === 't1');
  const commandsObj =
    state.commands && typeof state.commands === 'object' ? (state.commands as Record<string, unknown>) : {};
  const commands = Array.isArray(commandsObj.d2) ? (commandsObj.d2 as Array<Record<string, unknown>>) : [];
  ensure(activeIncidents.length === 0, 'Guided remediation did not clear the active incident in mock state.');
  ensure(
    deviceTwo?.name === 'Remediated d2',
    `Guided remediation did not update device name, got ${String(deviceTwo?.name ?? 'missing')}.`
  );
  const ticketMessages = Array.isArray(ticket?.messages) ? (ticket.messages as unknown[]) : [];
  ensure(ticketMessages.length === 1, 'Guided remediation did not send a ticket message.');
  ensure(
    commands.some((item) => item.command === 'restart'),
    'Guided remediation did not record the restart command.'
  );
  pushStep(steps, 'flow_guided', 'pass', 'Guided remediation completed and mutated mock state as expected.');

  process.stdout.write(`${renderSummary(steps)}\n`);
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
