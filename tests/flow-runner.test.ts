import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it, vi } from 'vitest';

import { createXyteClient } from '../src/client/create-client';
import type { BuiltInFlowDefinition } from '../src/workflows/flow-catalog';
import { runDeterministicFlow } from '../src/workflows/flow-runner';
import { MemorySecretStore } from '../src/secure/secret-store';
import { MemoryProfileStore } from './support/memory-profile-store';

async function makeClient() {
  const profileStore = new MemoryProfileStore();
  const secretStore = new MemorySecretStore();
  await profileStore.upsertTenant({ id: 'acme' });
  await profileStore.setActiveTenant('acme');
  const slot = await profileStore.addKeySlot('acme', {
    provider: 'xyte-org',
    name: 'primary',
    fingerprint: 'sha256:test'
  });
  await profileStore.setActiveKeySlot('acme', 'xyte-org', slot.slotId);
  await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key');

  const client = createXyteClient({
    profileStore,
    secretStore,
    tenantId: 'acme'
  });

  return {
    profileStore,
    secretStore,
    client
  };
}

async function makeClientWithProviders(providers: Array<'xyte-org' | 'xyte-partner'>) {
  const profileStore = new MemoryProfileStore();
  const secretStore = new MemorySecretStore();
  await profileStore.upsertTenant({ id: 'acme' });
  await profileStore.setActiveTenant('acme');

  if (providers.includes('xyte-org')) {
    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'org-primary',
      fingerprint: 'sha256:org'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-org', slot.slotId);
    await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key');
  }

  if (providers.includes('xyte-partner')) {
    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-partner',
      name: 'partner-primary',
      fingerprint: 'sha256:partner'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-partner', slot.slotId);
    await secretStore.setSlotSecret('acme', 'xyte-partner', slot.slotId, 'partner-key');
  }

  const client = createXyteClient({
    profileStore,
    secretStore,
    tenantId: 'acme'
  });

  return {
    profileStore,
    secretStore,
    client
  };
}

describe('flow runner', () => {
  it('resumes from a pending gate and advances one gate per apply invocation', async () => {
    const { profileStore, secretStore, client } = await makeClient();

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/organization/incidents')) {
        return new Response(JSON.stringify({ items: [{ id: 'inc-1', uuid: 'inc-1', device_id: 'dev-1', status: 'active' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.guided-remediation',
      title: 'Test Flow',
      intent: 'test',
      writeCapable: true,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'watch_once',
          title: 'Watch Once',
          command: 'xyte-cli watch --once',
          task: 'watch',
          mutating: false,
          watch: {
            profile: 'incidents-active',
            once: false,
            intervalMs: 250,
            maxPolls: 2
          }
        },
        {
          kind: 'gate',
          id: 'gate_1',
          title: 'Gate One',
          command: 'Human gate 1',
          mutating: true,
          detail: 'first gate'
        },
        {
          kind: 'task',
          id: 'send_command',
          title: 'Send Command',
          command: 'xyte-cli call organization.commands.sendCommand',
          task: 'call',
          mutating: true,
          requiresContext: ['device_id', 'command'],
          call: {
            endpointKey: 'organization.commands.sendCommand',
            path: { device_id: '{{device_id}}' },
            body: { command: '{{command}}' },
            outputMode: 'envelope'
          }
        },
        {
          kind: 'gate',
          id: 'gate_2',
          title: 'Gate Two',
          command: 'Human gate 2',
          mutating: true,
          detail: 'second gate'
        }
      ]
    };

    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-resume`);
    const first = await runDeterministicFlow({
      flowId: 'flow.custom-remediation',
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'plan',
      allowWrite: false,
      outDir,
      context: {
        device_id: 'dev-1',
        command: 'restart'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(first.outcome).toBe('pending_gate');
    expect(first.cursor.nextStepId).toBe('gate_1');

    const second = await runDeterministicFlow({
      flowId: 'flow.custom-remediation',
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'apply',
      allowWrite: true,
      outDir,
      resume: first.runId,
      context: {
        device_id: 'dev-1',
        command: 'restart'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(second.outcome).toBe('pending_gate');
    expect(second.cursor.nextStepId).toBe('gate_2');
    expect(second.decisions.approved).toBeGreaterThanOrEqual(1);
    expect(second.steps.find((item) => item.stepId === 'send_command')?.status).toBe('completed');
  });

  it('reduces watch loops to one poll when --once is enabled', async () => {
    const { profileStore, secretStore, client } = await makeClient();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [{ id: 'inc-1', uuid: 'inc-1', device_id: 'dev-1', status: 'active' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.incidents-delta-watch',
      title: 'Watch Loop',
      intent: 'watch',
      writeCapable: false,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'watch_loop',
          title: 'Watch Loop',
          command: 'xyte-cli watch --interval-ms 250 --max-polls 3',
          task: 'watch',
          mutating: false,
          watch: {
            profile: 'incidents-active',
            once: false,
            intervalMs: 250,
            maxPolls: 3
          }
        }
      ]
    };

    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-once`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'plan',
      allowWrite: false,
      outDir,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    const watchPath = result.steps.find((item) => item.stepId === 'watch_loop')?.artifactPath;
    expect(watchPath).toBeDefined();
    const lines = readFileSync(watchPath!, 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBe(1);
  });

  it('classifies known 422 sendCommand errors as needs_data', async () => {
    const { profileStore, secretStore, client } = await makeClient();

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({ error: 'Either a valid command or friendly_name is required' }), {
          status: 422,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.guided-remediation',
      title: 'Send command only',
      intent: 'send command',
      writeCapable: true,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'send_command',
          title: 'Send Command',
          command: 'xyte-cli call organization.commands.sendCommand',
          task: 'call',
          mutating: true,
          requiresContext: ['device_id', 'command'],
          call: {
            endpointKey: 'organization.commands.sendCommand',
            path: { device_id: '{{device_id}}' },
            body: { command: '{{command}}' },
            outputMode: 'envelope'
          }
        }
      ]
    };

    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-needs-data`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'apply',
      allowWrite: true,
      outDir,
      context: {
        device_id: 'dev-1',
        command: 'restart'
      },
      once: false,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(result.outcome).toBe('needs_input');
    expect(result.classifications.needs_data).toBe(1);
    expect(result.classifications.bug).toBe(0);
  });

  it('runs inspect.deep-dive and report.generate with partner-only provider scope', async () => {
    const { profileStore, secretStore, client } = await makeClientWithProviders(['xyte-partner']);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/partner/devices')) {
        return new Response(JSON.stringify({ items: [{ id: 'pd-1', status: 'online', name: 'Partner Device' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/tickets')) {
        return new Response(JSON.stringify({ items: [{ id: 'pt-1', status: 'open', created_at: new Date().toISOString() }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.daily-deep-dive-report',
      title: 'Deep dive and report',
      intent: 'test provider-scoped inspect',
      writeCapable: false,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'inspect_deep_dive_daily',
          title: 'Inspect Deep Dive',
          command: 'xyte-cli inspect deep-dive --tenant <tenant-id>',
          task: 'inspect.deep-dive',
          mutating: false,
          inspect: {
            mode: 'deep-dive',
            windowHours: 24
          }
        },
        {
          kind: 'task',
          id: 'report_daily',
          title: 'Generate Report',
          command: 'xyte-cli report generate --tenant <tenant-id>',
          task: 'report.generate',
          mutating: false,
          report: {
            inputFromStepId: 'inspect_deep_dive_daily',
            outFileName: 'daily.md',
            format: 'markdown'
          }
        }
      ]
    };

    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-provider-partner`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'plan',
      allowWrite: false,
      inspectProviderScope: 'auto',
      outDir,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(result.outcome).toBe('completed');
    expect(result.steps.find((item) => item.stepId === 'inspect_deep_dive_daily')?.status).toBe('completed');
    expect(result.steps.find((item) => item.stepId === 'report_daily')?.status).toBe('completed');
    const reportArtifact = result.steps.find((item) => item.stepId === 'report_daily')?.artifactPath;
    expect(reportArtifact).toBeDefined();
    expect(existsSync(reportArtifact!)).toBe(true);
  });

  it('reuses persisted inspect provider scope when resuming without explicit scope', async () => {
    const { profileStore, secretStore, client } = await makeClientWithProviders(['xyte-org', 'xyte-partner']);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/partner/devices')) {
        return new Response(JSON.stringify({ items: [{ id: 'pd-1', status: 'online', name: 'Partner Device' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/tickets')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.daily-deep-dive-report',
      title: 'Resume inspect scope',
      intent: 'resume should preserve inspect scope',
      writeCapable: true,
      recipeCommands: [],
      steps: [
        {
          kind: 'gate',
          id: 'gate_1',
          title: 'Approval',
          command: 'Human gate',
          mutating: true,
          detail: 'approve resume'
        },
        {
          kind: 'task',
          id: 'inspect_deep_dive_daily',
          title: 'Inspect Deep Dive',
          command: 'xyte-cli inspect deep-dive --tenant <tenant-id>',
          task: 'inspect.deep-dive',
          mutating: false,
          inspect: {
            mode: 'deep-dive',
            windowHours: 24
          }
        }
      ]
    };

    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-resume-inspect-scope`);
    const first = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'plan',
      allowWrite: false,
      inspectProviderScope: 'partner',
      outDir,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });
    expect(first.outcome).toBe('pending_gate');
    expect(first.resumeCommand).toContain('--inspect-provider-scope partner');

    const second = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'apply',
      allowWrite: true,
      outDir,
      resume: first.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(second.outcome).toBe('completed');
    expect(second.steps.find((item) => item.stepId === 'inspect_deep_dive_daily')?.status).toBe('completed');
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.length).toBeGreaterThan(0);
    expect(calledUrls.every((url) => url.includes('/partner/'))).toBe(true);
  });

  it('hydrates prior task outputs on resume so report.generate can use earlier deep-dive step', async () => {
    const { profileStore, secretStore, client } = await makeClientWithProviders(['xyte-partner']);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/partner/devices')) {
        return new Response(JSON.stringify({ items: [{ id: 'pd-1', status: 'online', name: 'Partner Device' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/tickets')) {
        return new Response(JSON.stringify({ items: [{ id: 'pt-1', status: 'open', created_at: new Date().toISOString() }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.daily-deep-dive-report',
      title: 'Resume report from prior inspect',
      intent: 'resume should rehydrate task outputs',
      writeCapable: true,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'inspect_deep_dive_daily',
          title: 'Inspect Deep Dive',
          command: 'xyte-cli inspect deep-dive --tenant <tenant-id>',
          task: 'inspect.deep-dive',
          mutating: false,
          inspect: {
            mode: 'deep-dive',
            windowHours: 24
          }
        },
        {
          kind: 'gate',
          id: 'gate_1',
          title: 'Approval',
          command: 'Human gate',
          mutating: true,
          detail: 'approve report'
        },
        {
          kind: 'task',
          id: 'report_daily',
          title: 'Generate Report',
          command: 'xyte-cli report generate --tenant <tenant-id>',
          task: 'report.generate',
          mutating: false,
          report: {
            inputFromStepId: 'inspect_deep_dive_daily',
            outFileName: 'daily.md',
            format: 'markdown'
          }
        }
      ]
    };

    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-resume-report`);
    const first = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'plan',
      allowWrite: false,
      inspectProviderScope: 'auto',
      outDir,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });
    expect(first.outcome).toBe('pending_gate');
    expect(first.steps.find((item) => item.stepId === 'inspect_deep_dive_daily')?.status).toBe('completed');

    const second = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'apply',
      allowWrite: true,
      outDir,
      resume: first.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(second.outcome).toBe('completed');
    expect(second.steps.find((item) => item.stepId === 'report_daily')?.status).toBe('completed');
    const reportArtifact = second.steps.find((item) => item.stepId === 'report_daily')?.artifactPath;
    expect(reportArtifact).toBeDefined();
    expect(existsSync(reportArtifact!)).toBe(true);
  });

  it('preserves deep-dive parse failure reason in report.generate needs_input errors', async () => {
    const { profileStore, secretStore, client } = await makeClient();

    const definition: BuiltInFlowDefinition = {
      id: 'flow.daily-deep-dive-report',
      title: 'Report parse failure context',
      intent: 'surface report input parse details',
      writeCapable: false,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'status_fast',
          title: 'Status Fast',
          command: 'xyte-cli status --mode fast',
          task: 'status.fast',
          mutating: false
        },
        {
          kind: 'task',
          id: 'report_daily',
          title: 'Generate Report',
          command: 'xyte-cli report generate --tenant <tenant-id>',
          task: 'report.generate',
          mutating: false,
          report: {
            inputFromStepId: 'status_fast',
            outFileName: 'daily.md',
            format: 'markdown'
          }
        }
      ]
    };

    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-report-parse-context`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'plan',
      allowWrite: false,
      outDir,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(result.outcome).toBe('needs_input');
    expect(result.classifications.needs_data).toBe(1);
    expect(result.classifications.bug).toBe(0);
    const failedStep = result.steps.find((item) => item.stepId === 'report_daily');
    expect(failedStep?.status).toBe('failed');
    expect(failedStep?.classification).toBe('needs_data');
    expect(String(failedStep?.error?.detail ?? '')).toContain('Step report_daily requires deep-dive output from status_fast.');
    expect(String(failedStep?.error?.detail ?? '')).toContain(
      'Input JSON must be produced by `xyte-cli inspect deep-dive --format json`.'
    );
  });

  it('classifies ambiguous auto inspect scope as needs_input when both provider credentials exist', async () => {
    const { profileStore, secretStore, client } = await makeClientWithProviders(['xyte-org', 'xyte-partner']);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.daily-deep-dive-report',
      title: 'Deep dive only',
      intent: 'test ambiguous inspect scope',
      writeCapable: false,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'inspect_deep_dive_daily',
          title: 'Inspect Deep Dive',
          command: 'xyte-cli inspect deep-dive --tenant <tenant-id>',
          task: 'inspect.deep-dive',
          mutating: false,
          inspect: {
            mode: 'deep-dive',
            windowHours: 24
          }
        }
      ]
    };

    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-provider-ambiguous`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'plan',
      allowWrite: false,
      inspectProviderScope: 'auto',
      outDir,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(result.outcome).toBe('needs_input');
    expect(result.classifications.needs_data).toBe(1);
    expect(result.classifications.bug).toBe(0);
    const failedStep = result.steps.find((item) => item.stepId === 'inspect_deep_dive_daily');
    expect(failedStep?.status).toBe('failed');
    expect(String(failedStep?.error?.detail ?? '')).toContain('both organization and partner credentials are configured');
  });

  it('classifies ambiguous auto inspect fleet scope as needs_input when both provider credentials exist', async () => {
    const { profileStore, secretStore, client } = await makeClientWithProviders(['xyte-org', 'xyte-partner']);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.daily-deep-dive-report',
      title: 'Fleet inspect only',
      intent: 'test ambiguous inspect fleet scope',
      writeCapable: false,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'inspect_fleet_daily',
          title: 'Inspect Fleet',
          command: 'xyte-cli inspect fleet --tenant <tenant-id>',
          task: 'inspect.fleet',
          mutating: false,
          inspect: {
            mode: 'fleet'
          }
        }
      ]
    };

    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-provider-ambiguous-fleet`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'plan',
      allowWrite: false,
      inspectProviderScope: 'auto',
      outDir,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(result.outcome).toBe('needs_input');
    expect(result.classifications.needs_data).toBe(1);
    expect(result.classifications.bug).toBe(0);
    const failedStep = result.steps.find((item) => item.stepId === 'inspect_fleet_daily');
    expect(failedStep?.status).toBe('failed');
    expect(String(failedStep?.error?.detail ?? '')).toContain('both organization and partner credentials are configured');
  });

  it('classifies explicit unavailable organization inspect scope as needs_input for inspect.deep-dive', async () => {
    const { profileStore, secretStore, client } = await makeClientWithProviders(['xyte-partner']);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.daily-deep-dive-report',
      title: 'Deep dive unavailable organization scope',
      intent: 'test explicit unavailable deep-dive scope',
      writeCapable: false,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'inspect_deep_dive_daily',
          title: 'Inspect Deep Dive',
          command: 'xyte-cli inspect deep-dive --tenant <tenant-id>',
          task: 'inspect.deep-dive',
          mutating: false,
          inspect: {
            mode: 'deep-dive',
            windowHours: 24
          }
        }
      ]
    };

    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-provider-explicit-unavailable-deep-dive`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'plan',
      allowWrite: false,
      inspectProviderScope: 'organization',
      outDir,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(result.outcome).toBe('needs_input');
    expect(result.classifications.needs_data).toBe(1);
    expect(result.classifications.bug).toBe(0);
    const failedStep = result.steps.find((item) => item.stepId === 'inspect_deep_dive_daily');
    expect(failedStep?.status).toBe('failed');
    expect(failedStep?.classification).toBe('needs_data');
    expect(String(failedStep?.error?.detail ?? '')).toContain('Inspect provider scope "organization" is unavailable');
  });

  it('classifies explicit unavailable partner inspect scope as needs_input for inspect.fleet', async () => {
    const { profileStore, secretStore, client } = await makeClientWithProviders(['xyte-org']);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.daily-deep-dive-report',
      title: 'Fleet unavailable partner scope',
      intent: 'test explicit unavailable fleet scope',
      writeCapable: false,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'inspect_fleet_daily',
          title: 'Inspect Fleet',
          command: 'xyte-cli inspect fleet --tenant <tenant-id>',
          task: 'inspect.fleet',
          mutating: false,
          inspect: {
            mode: 'fleet'
          }
        }
      ]
    };

    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-provider-explicit-unavailable-fleet`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'plan',
      allowWrite: false,
      inspectProviderScope: 'partner',
      outDir,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(result.outcome).toBe('needs_input');
    expect(result.classifications.needs_data).toBe(1);
    expect(result.classifications.bug).toBe(0);
    const failedStep = result.steps.find((item) => item.stepId === 'inspect_fleet_daily');
    expect(failedStep?.status).toBe('failed');
    expect(failedStep?.classification).toBe('needs_data');
    expect(String(failedStep?.error?.detail ?? '')).toContain('Inspect provider scope "partner" is unavailable');
  });

  it('prefers explicit inspect provider scope over persisted resume scope', async () => {
    const { profileStore, secretStore, client } = await makeClientWithProviders(['xyte-org', 'xyte-partner']);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/organization/devices')) {
        return new Response(JSON.stringify({ items: [{ id: 'od-1', status: 'online' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces')) {
        return new Response(JSON.stringify({ items: [{ id: 'os-1', name: 'HQ' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/incidents')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/tickets')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/partner/')) {
        throw new Error(`Partner endpoint should not be called when explicit organization scope is provided: ${url}`);
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.daily-deep-dive-report',
      title: 'Resume explicit scope precedence',
      intent: 'explicit inspect scope overrides persisted scope',
      writeCapable: true,
      recipeCommands: [],
      steps: [
        {
          kind: 'gate',
          id: 'gate_1',
          title: 'Approval',
          command: 'Human gate',
          mutating: true,
          detail: 'approve run'
        },
        {
          kind: 'task',
          id: 'inspect_fleet_daily',
          title: 'Inspect Fleet',
          command: 'xyte-cli inspect fleet --tenant <tenant-id>',
          task: 'inspect.fleet',
          mutating: false,
          inspect: {
            mode: 'fleet'
          }
        }
      ]
    };

    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-resume-explicit-scope-precedence`);
    const first = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'plan',
      allowWrite: false,
      inspectProviderScope: 'partner',
      outDir,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });
    expect(first.outcome).toBe('pending_gate');
    expect(first.resumeCommand).toContain('--inspect-provider-scope partner');

    const second = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'apply',
      allowWrite: true,
      outDir,
      resume: first.runId,
      inspectProviderScope: 'organization',
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(second.outcome).toBe('completed');
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.length).toBeGreaterThan(0);
    expect(calledUrls.every((url) => url.includes('/organization/'))).toBe(true);
  });

  it('falls back to auto scope when persisted inspect scope payload is malformed', async () => {
    const { profileStore, secretStore, client } = await makeClientWithProviders(['xyte-org', 'xyte-partner']);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.daily-deep-dive-report',
      title: 'Malformed persisted scope fallback',
      intent: 'fallback to auto when resume inputs are malformed',
      writeCapable: true,
      recipeCommands: [],
      steps: [
        {
          kind: 'gate',
          id: 'gate_1',
          title: 'Approval',
          command: 'Human gate',
          mutating: true,
          detail: 'approve run'
        },
        {
          kind: 'task',
          id: 'inspect_deep_dive_daily',
          title: 'Inspect Deep Dive',
          command: 'xyte-cli inspect deep-dive --tenant <tenant-id>',
          task: 'inspect.deep-dive',
          mutating: false,
          inspect: {
            mode: 'deep-dive',
            windowHours: 24
          }
        }
      ]
    };

    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-resume-malformed-scope`);
    const first = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'plan',
      allowWrite: false,
      inspectProviderScope: 'partner',
      outDir,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });
    expect(first.outcome).toBe('pending_gate');

    writeFileSync(first.inputsPath, '{malformed-json', 'utf8');

    const second = await runDeterministicFlow({
      flowId: definition.id,
      resolvedFlowId: definition.id,
      definition,
      tenantId: 'acme',
      mode: 'apply',
      allowWrite: true,
      outDir,
      resume: first.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(second.outcome).toBe('needs_input');
    expect(second.classifications.needs_data).toBe(1);
    expect(second.classifications.bug).toBe(0);
    const failedStep = second.steps.find((item) => item.stepId === 'inspect_deep_dive_daily');
    expect(failedStep?.status).toBe('failed');
    expect(String(failedStep?.error?.detail ?? '')).toContain('both organization and partner credentials are configured');
  });
});
