import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';

import callEnvelopeSchema from '../docs/schemas/call-envelope.v1.schema.json';
import deepDiveSchema from '../docs/schemas/inspect-deep-dive.v1.schema.json';
import fleetSchema from '../docs/schemas/inspect-fleet.v1.schema.json';
import flowRunSchema from '../docs/schemas/flow-run.v1.schema.json';
import headlessSchema from '../docs/schemas/headless-frame.v1.schema.json';
import reportSchema from '../docs/schemas/report.v1.schema.json';
import statusSchema from '../docs/schemas/status.v1.schema.json';
import upgradeCheckSchema from '../docs/schemas/upgrade-check.v1.schema.json';
import upgradeResultSchema from '../docs/schemas/upgrade-result.v1.schema.json';
import watchFrameSchema from '../docs/schemas/watch-frame.v1.schema.json';
import { buildCallEnvelope } from '../src/contracts/call-envelope';
import { buildFlowRunSummary } from '../src/contracts/flow-run';
import { buildStatusContract } from '../src/contracts/status';
import { buildWatchFrame } from '../src/contracts/watch-frame';
import { buildUpgradeCheck } from '../src/contracts/upgrade';
import { buildDeepDive, buildFleetInspect, generateFleetReport, generateOpsReport } from '../src/workflows/fleet-insights';
import { runHeadlessRenderer } from '../src/tui/headless-renderer';
import { MemorySecretStore } from '../src/secure/secret-store';
import { MemoryProfileStore } from './support/memory-profile-store';

const ajv = new Ajv2020({ strict: false });
const validateCallEnvelope = ajv.compile(callEnvelopeSchema);
const validateHeadless = ajv.compile(headlessSchema);
const validateFleet = ajv.compile(fleetSchema);
const validateDeepDive = ajv.compile(deepDiveSchema);
const validateFlowRun = ajv.compile(flowRunSchema);
const validateReport = ajv.compile(reportSchema);
const validateStatus = ajv.compile(statusSchema);
const validateUpgradeCheck = ajv.compile(upgradeCheckSchema);
const validateUpgradeResult = ajv.compile(upgradeResultSchema);
const validateWatchFrame = ajv.compile(watchFrameSchema);

describe('schema contracts', () => {
  it('validates call envelope payload', () => {
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
        durationMs: 10,
        retryCount: 0,
        data: { items: [] }
      }
    });

    expect(validateCallEnvelope(envelope)).toBe(true);
  });

  it('validates inspect and report payloads', async () => {
    const snapshot = {
      generatedAtUtc: new Date().toISOString(),
      tenantId: 'acme',
      devices: [{ id: 'd1', name: 'Device 1', status: 'offline', space: { full_path: 'Overview/A' } }],
      spaces: [{ id: 's1', name: 'Room A', space_type: 'room' }],
      incidents: [
        {
          id: 'i1',
          device_name: 'Device 1',
          status: 'active',
          space_tree_path_name: 'Overview/A',
          created_at: new Date().toISOString()
        }
      ],
      tickets: [{ id: 't1', title: 'Need help', status: 'open', created_at: new Date().toISOString(), device_id: 'd1' }]
    };

    const fleet = buildFleetInspect(snapshot);
    const deepDive = buildDeepDive(snapshot);
    expect(validateFleet(fleet)).toBe(true);
    expect(validateDeepDive(deepDive)).toBe(true);

    const report = await generateFleetReport({
      deepDive,
      format: 'markdown',
      outPath: '/tmp/xyte-contract-report.md',
      includeSensitive: false
    });

    expect(validateReport(report)).toBe(true);
  });

  it('validates migration report payloads from match and move summaries', async () => {
    const matchReport = await generateOpsReport({
      input: {
        schemaVersion: 'xyte.device.match.v1',
        generatedAtUtc: new Date().toISOString(),
        tenantId: 'acme',
        sourcePath: '/tmp/source.json',
        targetPath: '/tmp/target.json',
        sourceField: 'name',
        targetField: 'name',
        outputPath: '/tmp/device-moves.csv',
        summaryPath: '/tmp/device-moves.csv.summary.json',
        totals: {
          rows: 1,
          exact: 1,
          fuzzy: 0,
          unmatched: 0
        },
        matches: [
          {
            deviceId: 'dev-1',
            deviceName: 'South Wing Display',
            targetSpaceId: '99592',
            targetSpaceName: 'South Wing',
            confidence: 1,
            status: 'exact'
          }
        ]
      },
      tenantId: 'acme',
      format: 'markdown',
      outPath: '/tmp/xyte-match-report.md',
      includeSensitive: false
    });

    const moveReport = await generateOpsReport({
      input: {
        schemaVersion: 'xyte.utility.batch.v1',
        generatedAtUtc: new Date().toISOString(),
        tenantId: 'acme',
        command: 'device.move',
        mode: 'apply',
        totals: {
          rows: 3,
          succeeded: 2,
          failed: 0,
          skipped: 1
        },
        stoppedEarly: false,
        reportPath: '/tmp/device-migration.apply.ndjson'
      },
      tenantId: 'acme',
      format: 'markdown',
      outPath: '/tmp/xyte-move-report.md',
      includeSensitive: false
    });

    expect(validateReport(matchReport)).toBe(true);
    expect(validateReport(moveReport)).toBe(true);
  });

  it('validates headless runtime frame payload', async () => {
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

    expect(validateHeadless(runtimeFrame)).toBe(true);
  });

  it('validates status and upgrade payloads', () => {
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

    const upgradeCheck = buildUpgradeCheck({
      packageName: '@xyteai/cli',
      currentVersion: '0.4.0',
      latestVersion: '0.4.1'
    });

    const upgradeResult = {
      schemaVersion: 'xyte.upgrade.result.v1',
      generatedAtUtc: new Date().toISOString(),
      packageName: '@xyteai/cli',
      currentVersion: '0.4.0',
      latestVersion: '0.4.1',
      upToDateBefore: false,
      updated: true,
      updateCommand: {
        command: 'npm',
        args: ['install', '--global', '@xyteai/cli@latest']
      },
      verify: {
        command: {
          command: 'xyte-cli',
          args: ['--version']
        },
        detectedVersion: '0.4.1',
        expectedVersion: '0.4.1',
        match: true
      },
      skills: {
        scope: 'user',
        agents: ['claude', 'copilot', 'codex'],
        force: true,
        sourceDir: '/tmp/skills/xyte-cli',
        outcomes: [
          {
            scope: 'user',
            agent: 'codex',
            rootDir: '/tmp/.agents/skills',
            targetDir: '/tmp/.agents/skills/xyte-cli',
            status: 'installed'
          }
        ],
        failedCount: 0
      },
      warnings: []
    };

    expect(validateStatus(status)).toBe(true);
    expect(validateUpgradeCheck(upgradeCheck)).toBe(true);
    expect(validateUpgradeResult(upgradeResult)).toBe(true);
  });

  it('validates watch frame payload', () => {
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
        total: 1,
        added: 1,
        removed: 0,
        updated: 0,
        changed: true
      },
      delta: {
        added: [{ id: 'inc-1', current: { id: 'inc-1', status: 'active' } }],
        removed: [],
        updated: []
      }
    });

    expect(validateWatchFrame(frame)).toBe(true);
  });

  it('validates flow run summary payload', () => {
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
      outcome: 'completed',
      steps: [
        {
          stepId: 'status_fast',
          title: 'Status Fast',
          kind: 'task',
          command: 'xyte-cli status --mode fast --output json',
          status: 'completed'
        }
      ],
      decisions: {
        pending: 0,
        approved: 0,
        blocked: 0
      },
      classifications: {
        needs_data: 0,
        bug: 0
      },
      cursor: {
        nextStepIndex: 1
      }
    });

    expect(validateFlowRun(summary)).toBe(true);
  });
});
