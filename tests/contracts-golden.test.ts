import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCallEnvelope } from '../src/contracts/call-envelope';
import { buildFlowRunSummary } from '../src/contracts/flow-run';
import { buildStatusContract } from '../src/contracts/status';
import { buildWatchFrame } from '../src/contracts/watch-frame';
import { buildUpgradeCheck } from '../src/contracts/upgrade';
import { MemorySecretStore } from '../src/secure/secret-store';
import { runHeadlessRenderer } from '../src/tui/headless-renderer';
import { buildUtilityPrepare } from '../src/workflows/utility-prepare';
import { buildDeepDive, buildFleetInspect, generateFleetReport } from '../src/workflows/fleet-insights';
import { MemoryProfileStore } from './support/memory-profile-store';

const GOLDEN_DIR = resolve(__dirname, 'fixtures/golden');

function readGolden<T>(fileName: string): T {
  return JSON.parse(readFileSync(join(GOLDEN_DIR, fileName), 'utf8')) as T;
}

function normalizeCallEnvelope(value: unknown) {
  const envelope = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  envelope.timestamp = '<ISO_TIMESTAMP>';
  return envelope;
}

function normalizeReport(value: unknown) {
  const report = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  report.generatedAtUtc = '<ISO_TIMESTAMP>';
  report.outputPath = '<REPORT_PATH>';
  return report;
}

function normalizeUtilityPrepare(
  value: unknown,
  paths: {
    inputPath: string;
    outputDir: string;
  }
) {
  const result = JSON.parse(JSON.stringify(value)) as Record<string, any>;
  result.generatedAtUtc = '<ISO_TIMESTAMP>';
  result.input.path = '<INPUT_PATH>';
  result.artifacts.primary = result.artifacts.primary.replace(paths.outputDir, '<OUTPUT_DIR>');
  result.artifacts.rejected = result.artifacts.rejected.replace(paths.outputDir, '<OUTPUT_DIR>');
  result.artifacts.notes = result.artifacts.notes.replace(paths.outputDir, '<OUTPUT_DIR>');
  result.suggestedCommands.next = String(result.suggestedCommands.next).replace(paths.outputDir, '<OUTPUT_DIR>');
  return result;
}

function normalizeHeadlessFrame(value: unknown) {
  const frame = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  frame.timestamp = '<ISO_TIMESTAMP>';
  frame.sessionId = '<SESSION_ID>';
  frame.sequence = '<SEQUENCE>';
  return frame;
}

function normalizeGenerated(value: unknown) {
  const output = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  output.generatedAtUtc = '<ISO_TIMESTAMP>';
  return output;
}

function normalizeWatchFrame(value: unknown) {
  const frame = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  frame.timestamp = '<ISO_TIMESTAMP>';
  frame.runId = '<RUN_ID>';
  return frame;
}

function normalizeFlowRunSummary(value: unknown) {
  const summary = JSON.parse(JSON.stringify(value)) as Record<string, any>;
  summary.generatedAtUtc = '<ISO_TIMESTAMP>';
  summary.startedAtUtc = '<ISO_TIMESTAMP>';
  summary.endedAtUtc = '<ISO_TIMESTAMP>';
  return summary;
}

describe('golden contracts', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('matches call envelope contract', () => {
    const envelope = buildCallEnvelope({
      requestId: 'req-1',
      tenantId: 'acme',
      endpointKey: 'organization.devices.getDevices',
      method: 'GET',
      guard: {
        allowWrite: false
      },
      request: {
        path: {},
        query: {}
      },
      response: {
        status: 200,
        durationMs: 12,
        retryCount: 0,
        data: {
          items: [{ id: 'dev-1' }]
        }
      }
    });

    expect(normalizeCallEnvelope(envelope)).toEqual(readGolden('call-envelope.json'));
  });

  it('matches inspect and report contracts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-25T08:00:00.000Z'));

    const snapshot = {
      generatedAtUtc: '2026-02-25T00:00:00.000Z',
      tenantId: 'acme',
      devices: [
        { id: 'dev-1', name: 'Device One', status: 'offline', space: { full_path: 'Overview/A' } },
        { id: 'dev-2', name: 'Device Two', status: 'online', space: { full_path: 'Overview/A' } }
      ],
      spaces: [{ id: 'sp-1', name: 'Room A', space_type: 'room' }],
      incidents: [
        {
          id: 'inc-1',
          device_name: 'Device One',
          status: 'active',
          space_tree_path_name: 'Overview/A',
          created_at: '2026-02-24T00:00:00.000Z'
        }
      ],
      tickets: [
        {
          id: 'tic-1',
          title: 'Need help',
          status: 'open',
          created_at: '2026-02-24T00:00:00.000Z',
          device_id: 'dev-1'
        }
      ]
    };

    const fleet = buildFleetInspect(snapshot);
    const deepDive = buildDeepDive(snapshot);
    const tmpRoot = mkdtempSync(join(tmpdir(), 'xyte-golden-report-'));
    const report = await generateFleetReport({
      deepDive,
      format: 'markdown',
      outPath: join(tmpRoot, 'fleet-report.md'),
      includeSensitive: false
    });

    expect(fleet).toEqual(readGolden('inspect-fleet.json'));
    expect(deepDive).toEqual(readGolden('inspect-deep-dive.json'));
    expect(normalizeReport(report)).toEqual(readGolden('report.json'));
  });

  it('matches utility prepare contract', () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'xyte-golden-prepare-'));
    const inputPath = join(tmpRoot, 'input.csv');
    const outputDir = join(tmpRoot, 'output');
    writeFileSync(inputPath, 'raw', 'utf8');

    const result = buildUtilityPrepare({
      inputPath,
      actionKey: 'organization.devices.claimDevice',
      outputDir,
      tenantId: 'acme'
    });

    expect(
      normalizeUtilityPrepare(result, {
        inputPath,
        outputDir
      })
    ).toEqual(readGolden('utility-prepare.json'));
  });

  it('matches headless frame contract', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();

    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');

    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'primary',
      fingerprint: 'sha256:test'
    });
    await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key');

    const chunks: string[] = [];
    const output = {
      write: (text: string) => {
        chunks.push(text);
        return true;
      }
    };

    const client: any = {
      organization: {
        getDevices: async () => [{ id: 'dev-1', name: 'Device One', status: 'online' }],
        getIncidents: async () => [{ id: 'inc-1', severity: 'high', status: 'open' }],
        getTickets: async () => [{ id: 'tic-1', subject: 'Need help', status: 'open' }],
        getSpaces: async () => [{ id: 'sp-1', name: 'Room A', space_type: 'room' }],
        getSpace: async () => ({ id: 'sp-1', name: 'Room A' })
      },
      partner: {
        getDevices: async () => [],
        getTickets: async () => []
      }
    };

    await runHeadlessRenderer({
      client,
      profileStore,
      secretStore,
      screen: 'spaces',
      format: 'json',
      motionEnabled: false,
      follow: false,
      output
    });

    const runtimeFrame = chunks
      .join('')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .find((frame) => !(frame.meta?.startup ?? false));

    expect(normalizeHeadlessFrame(runtimeFrame)).toEqual(readGolden('headless-frame.json'));
  });

  it('matches status contract', () => {
    const status = buildStatusContract({
      mode: 'fast',
      checkConnectivity: false,
      readiness: {
        state: 'needs_setup',
        missingItems: ['No active tenant is configured.'],
        recommendedActions: ['Run "xyte-cli setup run --non-interactive --tenant default --key <value>".'],
        providers: [],
        connectionState: 'not_checked',
        connectivity: {
          state: 'not_checked',
          message: 'Connectivity not checked.',
          retriable: false
        }
      }
    });

    expect(normalizeGenerated(status)).toEqual(readGolden('status.json'));
  });

  it('matches upgrade check contract', () => {
    const check = buildUpgradeCheck({
      packageName: '@xyteai/cli',
      currentVersion: '0.4.0',
      latestVersion: '0.4.1'
    });

    expect(normalizeGenerated(check)).toEqual(readGolden('upgrade-check.json'));
  });

  it('matches watch frame contract', () => {
    const frame = buildWatchFrame({
      runId: 'run-1',
      sequence: 0,
      pollIndex: 1,
      intervalMs: 2000,
      profile: 'incidents-active',
      endpointKey: 'organization.incidents.getIncidents',
      tenantId: 'acme',
      eventType: 'delta',
      query: {
        status: 'active',
        from: 0,
        to: 1700000000,
        page: 1,
        per_page: 100
      },
      summary: {
        total: 2,
        added: 1,
        removed: 0,
        updated: 1,
        changed: true
      },
      delta: {
        added: [{ id: 'inc-2', current: { id: 'inc-2', status: 'active' } }],
        removed: [],
        updated: [{ id: 'inc-1', before: { id: 'inc-1', status: 'active' }, after: { id: 'inc-1', status: 'resolved' } }]
      }
    });

    expect(normalizeWatchFrame(frame)).toEqual(readGolden('watch-frame.json'));
  });

  it('matches flow run summary contract', () => {
    const summary = buildFlowRunSummary({
      runId: 'run-1',
      flowId: 'flow.setup-readiness-10m',
      resolvedFlowId: 'flow.setup-readiness-10m',
      mode: 'plan',
      tenantId: 'acme',
      bundleDir: '/tmp/flow-runs/flow.setup-readiness-10m/run-1',
      manifestPath: '/tmp/flow-runs/flow.setup-readiness-10m/run-1/manifest.json',
      inputsPath: '/tmp/flow-runs/flow.setup-readiness-10m/run-1/inputs.json',
      decisionsPath: '/tmp/flow-runs/flow.setup-readiness-10m/run-1/decisions.ndjson',
      errorsPath: '/tmp/flow-runs/flow.setup-readiness-10m/run-1/errors.ndjson',
      watchFramesPath: '/tmp/flow-runs/flow.setup-readiness-10m/run-1/watch-frames.ndjson',
      startedAtUtc: new Date().toISOString(),
      endedAtUtc: new Date().toISOString(),
      durationMs: 123,
      outcome: 'pending_gate',
      nextResumeStepId: 'gate_send_command',
      resumeCommand:
        'xyte-cli flow run flow.guided-remediation --tenant acme --apply --inspect-provider-scope auto --resume run-1',
      steps: [
        {
          stepId: 'watch_before',
          title: 'Watch Before',
          kind: 'task',
          command: 'xyte-cli ops watch incidents --tenant <tenant-id> --profile incidents-active --once --strict-json > /tmp/xyte-watch.before.ndjson',
          status: 'completed'
        },
        {
          stepId: 'gate_send_command',
          title: 'Approve Send Command',
          kind: 'gate',
          command: 'Human decision gate before sendCommand',
          status: 'gate_pending'
        }
      ],
      decisions: {
        pending: 1,
        approved: 0,
        blocked: 0
      },
      classifications: {
        needs_data: 0,
        bug: 0
      },
      cursor: {
        nextStepIndex: 1,
        nextStepId: 'gate_send_command'
      }
    });

    expect(normalizeFlowRunSummary(summary)).toEqual(readGolden('flow-run.json'));
  });
});
