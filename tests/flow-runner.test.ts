import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createXyteClient } from '../src/client/create-client';
import { getBuiltInFlowDefinition, type BuiltInFlowDefinition, type BuiltInFlowId } from '../src/workflows/flow-catalog';
import * as fleetInsights from '../src/workflows/fleet-insights';
import { runDeterministicFlow } from '../src/workflows/flow-runner';
import { MemorySecretStore } from '../src/secure/secret-store';
import { MemoryProfileStore } from './support/memory-profile-store';

// Per-test overrides captured by the vi.mock factory closures below.
let builtInDefinitionOverride: BuiltInFlowDefinition | null = null;
let flowDefinitionOverride: Record<string, unknown> | null = null;
let runSpaceImportTreeOverride: (() => Promise<unknown>) | null = null;

vi.mock('../src/workflows/flow-catalog', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/workflows/flow-catalog')>();
  return {
    ...original,
    hasBuiltInFlowDefinition: (id: string) => builtInDefinitionOverride?.id === id || original.hasBuiltInFlowDefinition(id),
    getBuiltInFlowDefinition: (id: string) => builtInDefinitionOverride ?? original.getBuiltInFlowDefinition(id)
  };
});

vi.mock('../src/workflows/flow-user-definitions', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/workflows/flow-user-definitions')>();
  return {
    ...original,
    getFlowDefinition: async (id: string) => flowDefinitionOverride ?? original.getFlowDefinition(id)
  };
});

vi.mock('../src/workflows/utility-commands', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/workflows/utility-commands')>();
  return {
    ...original,
    runSpaceImportTree: async (args: Parameters<typeof original.runSpaceImportTree>[0]) =>
      runSpaceImportTreeOverride ? runSpaceImportTreeOverride() : original.runSpaceImportTree(args)
  };
});

async function makeClient() {
  const profileStore = new MemoryProfileStore();
  const secretStore = new MemorySecretStore();
  await profileStore.upsertTenant({ id: 'acme' });
  await profileStore.setActiveTenant('acme');
  const slot = await profileStore.addKeySlot('acme', 'xyte-org', {
    
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
    const slot = await profileStore.addKeySlot('acme', 'xyte-org', {
      
      name: 'org-primary',
      fingerprint: 'sha256:org'
    });
    await profileStore.setActiveKeySlot('acme', 'xyte-org', slot.slotId);
    await secretStore.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key');
  }

  if (providers.includes('xyte-partner')) {
    const slot = await profileStore.addKeySlot('acme', 'xyte-partner', {
      
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
  afterEach(() => {
    builtInDefinitionOverride = null;
    flowDefinitionOverride = null;
    runSpaceImportTreeOverride = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resumes from a pending gate and advances one gate per apply invocation', async () => {
    const { profileStore, secretStore, client } = await makeClient();

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/organization/incidents')) {
        return new Response(
          JSON.stringify({ items: [{ id: 'inc-1', uuid: 'inc-1', device_id: 'dev-1', status: 'active' }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
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
          command: 'xyte-cli ops watch incidents --once',
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
          command: 'xyte-cli api call organization.commands.sendCommand',
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

    builtInDefinitionOverride = definition;
    flowDefinitionOverride = {
      schemaVersion: 'xyte.flow.definition.v1',
      id: 'flow.custom-remediation',
      basedOn: definition.id,
      defaults: {},
      title: 'Custom Remediation',
      createdAtUtc: new Date().toISOString(),
      updatedAtUtc: new Date().toISOString(),
      path: '/tmp/flow.custom-remediation.json'
    };
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-resume`);
    const first = await runDeterministicFlow({
      flowId: 'flow.custom-remediation',
      tenantId: 'acme',
      mode: 'plan',
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
      tenantId: 'acme',
      mode: 'apply',
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

  it('persists derived guided remediation context across resume boundaries', async () => {
    const { profileStore, secretStore, client } = await makeClient();

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/organization/incidents')) {
        return new Response(
          JSON.stringify({ items: [{ id: 'inc-1', uuid: 'inc-1', device_id: 'dev-1', status: 'active' }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ items: [{ command: 'restart' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const definition = getBuiltInFlowDefinition('flow.guided-remediation');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-guided-defaults`);

    const first = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {
        ticket_id: 't-1'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(first.outcome).toBe('pending_gate');
    expect(first.cursor.nextStepId).toBe('gate_send_command');
    const persistedInputs = JSON.parse(readFileSync(first.inputsPath, 'utf8'));
    expect(persistedInputs.context.device_id).toBe('dev-1');
    expect(persistedInputs.context.incident_id).toBe('inc-1');
    expect(persistedInputs.context.command).toBe('restart');
    expect(persistedInputs.context.ticket_id).toBe('t-1');

    const second = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: first.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(second.outcome).toBe('pending_gate');
    expect(second.cursor.nextStepId).toBe('gate_update_device');
    expect(second.steps.find((item) => item.stepId === 'commands_send')?.status).toBe('completed');

    const third = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: first.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(third.outcome).toBe('pending_gate');
    expect(third.cursor.nextStepId).toBe('gate_ticket_message');
    expect(third.steps.find((item) => item.stepId === 'device_update')?.status).toBe('completed');
    expect(third.steps.find((item) => item.stepId === 'device_get_verify')?.status).toBe('completed');
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
          command: 'xyte-cli ops watch incidents --interval-ms 250 --max-polls 3',
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

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-once`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
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
          command: 'xyte-cli api call organization.commands.sendCommand',
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

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-needs-data`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
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

  it('reuses the transport requestId in flow call envelopes', async () => {
    const profileStore = new MemoryProfileStore();
    const secretStore = new MemorySecretStore();
    const callWithMeta = vi.fn(async (_endpointKey: string, _args: { requestId?: string }) => ({
      status: 200,
      durationMs: 12,
      retryCount: 0,
      data: { ok: true }
    }));

    const definition: BuiltInFlowDefinition = {
      id: 'flow.watch-to-triage',
      title: 'Request id correlation',
      intent: 'keep flow envelopes aligned with transport metadata',
      writeCapable: false,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'read_devices',
          title: 'Read Devices',
          command: 'xyte-cli api call organization.devices.getDevices',
          task: 'call',
          mutating: false,
          call: {
            endpointKey: 'organization.devices.getDevices',
            outputMode: 'envelope'
          }
        }
      ]
    };

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-request-id`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client: {
        callWithMeta
      } as any
    });

    expect(result.outcome).toBe('completed');
    expect(callWithMeta).toHaveBeenCalledTimes(1);
    const requestId = callWithMeta.mock.calls[0]?.[1]?.requestId;
    expect(typeof requestId).toBe('string');
    const artifactPath = result.steps.find((step) => step.stepId === 'read_devices')?.artifactPath;
    expect(artifactPath).toBeDefined();
    const envelope = JSON.parse(readFileSync(artifactPath!, 'utf8'));
    expect(envelope.requestId).toBe(requestId);
  });

  it('runs flow.device-migration across gates and persists match artifacts for resume', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-migration');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-migration`);
    let currentSpaceId = 900;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/organization/devices?') && url.includes('space_id=900')) {
        return new Response(
          JSON.stringify({
            items:
              currentSpaceId === 900
                ? [{ id: 'dev-1', name: 'South Wing', space_id: 900 }]
                : []
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      if (url.includes('/organization/devices') && !url.includes('/organization/devices/dev-1')) {
        return new Response(
          JSON.stringify({ items: [{ id: 'dev-1', name: 'South Wing', space_id: currentSpaceId }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      if (url.includes('/organization/spaces?') && url.includes('path_includes=Regional+Offices')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces?') && url.includes('id=99592')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/incidents') || url.includes('/organization/tickets')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/move') && (init?.method ?? 'GET') === 'POST') {
        currentSpaceId = 99592;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1')) {
        return new Response(JSON.stringify({ id: 'dev-1', name: 'South Wing', space_id: currentSpaceId }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const plan = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {
        source_space_id: '900',
        target_path_includes: 'Regional Offices'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(plan.outcome).toBe('pending_gate');
    expect(plan.cursor.nextStepId).toBe('gate_approve_mapping');
    const plannedInputs = JSON.parse(readFileSync(plan.inputsPath, 'utf8'));
    expect(plannedInputs.context.inventory_source_artifact).toBeDefined();
    expect(plannedInputs.context.inventory_target_artifact).toBeDefined();
    expect(plannedInputs.context.match_devices_output).toContain('device-moves.csv');
    expect(plan.steps.find((item) => item.stepId === 'inventory_target')?.command).toBe(
      'xyte-cli api call organization.spaces.getSpaces --tenant <tenant-id> --query path_includes=<target-path> --output json > ./artifacts/target-spaces.json'
    );

    const dryRun = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: plan.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(dryRun.outcome).toBe('pending_gate');
    expect(dryRun.cursor.nextStepId).toBe('gate_approve_execution');
    expect(dryRun.steps.find((item) => item.stepId === 'dry_run_moves')?.status).toBe('completed');

    const applied = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: plan.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(applied.outcome).toBe('completed');
    expect(applied.steps.find((item) => item.stepId === 'execute_moves')?.status).toBe('completed');
    expect(applied.steps.find((item) => item.stepId === 'post_migration_report')?.status).toBe('completed');
    expect(currentSpaceId).toBe(99592);
    const postReportPath = applied.steps.find((item) => item.stepId === 'post_migration_report')?.artifactPath;
    expect(postReportPath).toBeDefined();
    const postReport = readFileSync(postReportPath!, 'utf8');
    expect(postReport).toContain('Verified: 1');
    expect(postReport).toContain('Fleet devices: 1');
  });

  it('completes flow.device-migration when unrelated devices remain outside the move plan', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-migration');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-migration-partial`);
    const currentSpaceByDevice = new Map<string, number>([
      ['dev-1', 900],
      ['dev-2', 900]
    ]);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/organization/devices?') && url.includes('space_id=900')) {
        return new Response(JSON.stringify({ items: [{ id: 'dev-1', name: 'South Wing', space_id: 900 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices') && !url.includes('/organization/devices/dev-1')) {
        return new Response(
          JSON.stringify({
            items: [
              { id: 'dev-1', name: 'South Wing', space_id: currentSpaceByDevice.get('dev-1') },
              { id: 'dev-2', name: 'Storage', space_id: currentSpaceByDevice.get('dev-2') }
            ]
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      if (url.includes('/organization/spaces?') && url.includes('path_includes=Regional+Offices')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces?') && url.includes('id=99592')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/incidents') || url.includes('/organization/tickets')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/move') && (init?.method ?? 'GET') === 'POST') {
        currentSpaceByDevice.set('dev-1', 99592);
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1')) {
        return new Response(
          JSON.stringify({ id: 'dev-1', name: 'South Wing', space_id: currentSpaceByDevice.get('dev-1') }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const plan = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {
        source_space_id: '900',
        target_path_includes: 'Regional Offices'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: plan.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    const applied = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: plan.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(applied.outcome).toBe('completed');
    expect(currentSpaceByDevice.get('dev-1')).toBe(99592);
    expect(currentSpaceByDevice.get('dev-2')).toBe(900);
    expect(applied.steps.find((item) => item.stepId === 'verify_moved_devices')?.status).toBe('completed');
    const postReportPath = applied.steps.find((item) => item.stepId === 'post_migration_report')?.artifactPath;
    expect(postReportPath).toBeDefined();
    const postReport = readFileSync(postReportPath!, 'utf8');
    expect(postReport).toContain('Verified: 1');
    expect(postReport).toContain('Fleet devices: 2');
  });

  it('fails flow.device-migration when dry_run_moves reports failed move rows', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-migration');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-migration-dry-run-fail`);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/organization/devices?') && url.includes('space_id=900')) {
        return new Response(JSON.stringify({ items: [{ id: 'dev-1', name: 'South Wing', space_id: 900 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices') && !url.includes('/organization/devices/dev-1')) {
        return new Response(JSON.stringify({ items: [{ id: 'dev-1', name: 'South Wing', space_id: 900 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces?') && url.includes('path_includes=Regional+Offices')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces?') && url.includes('id=99592')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/incidents') || url.includes('/organization/tickets')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1')) {
        return new Response(JSON.stringify({ id: 'dev-1', name: 'South Wing', space_id: 900 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const plan = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {
        source_space_id: '900',
        target_path_includes: 'Regional Offices'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    const failed = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: plan.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(failed.outcome).toBe('failed');
    expect(failed.steps.find((item) => item.stepId === 'dry_run_moves')?.error?.detail).toContain(
      'Step dry_run_moves failed because the move batch reported 1 failed row(s).'
    );
    expect(failed.steps.find((item) => item.stepId === 'gate_approve_execution')?.status).not.toBe('completed');
    expect(failed.steps.find((item) => item.stepId === 'execute_moves')?.status).not.toBe('completed');
  });

  it('fails flow.device-migration when execute_moves reports failed move rows', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-migration');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-migration-execute-fail`);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/organization/devices?') && url.includes('space_id=900')) {
        return new Response(JSON.stringify({ items: [{ id: 'dev-1', name: 'South Wing', space_id: 900 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices') && !url.includes('/organization/devices/dev-1')) {
        return new Response(JSON.stringify({ items: [{ id: 'dev-1', name: 'South Wing', space_id: 900 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces?') && url.includes('path_includes=Regional+Offices')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces?') && url.includes('id=99592')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/incidents') || url.includes('/organization/tickets')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/move') && (init?.method ?? 'GET') === 'POST') {
        throw new Error('move failed');
      }
      if (url.includes('/organization/devices/dev-1')) {
        return new Response(JSON.stringify({ id: 'dev-1', name: 'South Wing', space_id: 900 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const plan = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {
        source_space_id: '900',
        target_path_includes: 'Regional Offices'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: plan.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    const failed = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: plan.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(failed.outcome).toBe('failed');
    expect(failed.steps.find((item) => item.stepId === 'execute_moves')?.error?.detail).toContain(
      'Step execute_moves failed because the move batch reported 1 failed row(s).'
    );
    expect(failed.steps.find((item) => item.stepId === 'verify_fleet')?.status).not.toBe('completed');
    expect(failed.steps.find((item) => item.stepId === 'post_migration_report')?.status).not.toBe('completed');
  });

  it('fails flow.device-migration when a planned device resolves to the wrong target space', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-migration');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-migration-fail`);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/organization/devices?') && url.includes('space_id=900')) {
        return new Response(JSON.stringify({ items: [{ id: 'dev-1', name: 'South Wing', space_id: 900 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices') && !url.includes('/organization/devices/dev-1')) {
        return new Response(JSON.stringify({ items: [{ id: 'dev-1', name: 'South Wing', space_id: 99592 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces?') && url.includes('path_includes=Regional+Offices')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces?') && url.includes('id=99592')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/incidents') || url.includes('/organization/tickets')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/move') && (init?.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1')) {
        return new Response(JSON.stringify({ id: 'dev-1', name: 'South Wing', space_id: 55123 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const plan = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {
        source_space_id: '900',
        target_path_includes: 'Regional Offices'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: plan.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    const failed = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: plan.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(failed.outcome).toBe('failed');
    expect(failed.steps.find((item) => item.stepId === 'verify_moved_devices')?.error?.detail).toContain(
      'found 1 mismatched and 0 missing planned device(s)'
    );
    expect(failed.steps.find((item) => item.stepId === 'post_migration_report')?.status).not.toBe('completed');
  });

  it('fails flow.device-migration when a planned device cannot be fetched during verification', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-migration');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-migration-missing-fetch`);
    let failVerificationFetch = false;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/organization/devices?') && url.includes('space_id=900')) {
        return new Response(JSON.stringify({ items: [{ id: 'dev-1', name: 'South Wing', space_id: 900 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices') && !url.includes('/organization/devices/dev-1')) {
        return new Response(JSON.stringify({ items: [{ id: 'dev-1', name: 'South Wing', space_id: 99592 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces?') && url.includes('path_includes=Regional+Offices')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces?') && url.includes('id=99592')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/incidents') || url.includes('/organization/tickets')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/move') && (init?.method ?? 'GET') === 'POST') {
        failVerificationFetch = true;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1')) {
        if (failVerificationFetch) {
          return new Response(JSON.stringify({ error: 'gone' }), {
            status: 404,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ id: 'dev-1', name: 'South Wing', space_id: 900 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const plan = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {
        source_space_id: '900',
        target_path_includes: 'Regional Offices'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: plan.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    const failed = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: plan.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(failed.outcome).toBe('failed');
    expect(failed.steps.find((item) => item.stepId === 'verify_moved_devices')?.error?.detail).toContain(
      'found 0 mismatched and 1 missing planned device(s)'
    );
    expect(failed.steps.find((item) => item.stepId === 'post_migration_report')?.status).not.toBe('completed');
  });

  it('fails flow.device-migration when a planned device returns an unusable verification payload', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-migration');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-migration-missing-payload`);
    let returnUnusablePayload = false;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/organization/devices?') && url.includes('space_id=900')) {
        return new Response(JSON.stringify({ items: [{ id: 'dev-1', name: 'South Wing', space_id: 900 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices') && !url.includes('/organization/devices/dev-1')) {
        return new Response(JSON.stringify({ items: [{ id: 'dev-1', name: 'South Wing', space_id: 99592 }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces?') && url.includes('path_includes=Regional+Offices')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces?') && url.includes('id=99592')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/incidents') || url.includes('/organization/tickets')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/move') && (init?.method ?? 'GET') === 'POST') {
        returnUnusablePayload = true;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1')) {
        if (returnUnusablePayload) {
          return new Response(JSON.stringify({ id: 'dev-1', name: 'South Wing', space: {} }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ id: 'dev-1', name: 'South Wing', space_id: 900 }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const plan = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {
        source_space_id: '900',
        target_path_includes: 'Regional Offices'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: plan.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    const failed = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: plan.runId,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(failed.outcome).toBe('failed');
    expect(failed.steps.find((item) => item.stepId === 'verify_moved_devices')?.error?.detail).toContain(
      'found 0 mismatched and 1 missing planned device(s)'
    );
    expect(failed.steps.find((item) => item.stepId === 'post_migration_report')?.status).not.toBe('completed');
  });

  it('calls the migration-specific post report helper and completes the flow', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-migration');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-migration-await-report`);
    let currentSpaceId = 900;
    let reportCalled = false;

    const reportSpy = vi.spyOn(fleetInsights, 'generateDeviceMigrationReport').mockImplementation((args) => {
      reportCalled = true;
      writeFileSync(args.outPath, '# Device Migration Post-Execution Report\n', 'utf8');
      return {
        schemaVersion: 'xyte.report.v1',
        generatedAtUtc: new Date().toISOString(),
        tenantId: args.tenantId,
        format: 'markdown',
        outputPath: args.outPath,
        includeSensitive: false
      };
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/organization/devices?') && url.includes('space_id=900')) {
        return new Response(
          JSON.stringify({
            items:
              currentSpaceId === 900
                ? [{ id: 'dev-1', name: 'South Wing', space_id: 900 }]
                : []
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      if (url.includes('/organization/devices') && !url.includes('/organization/devices/dev-1')) {
        return new Response(
          JSON.stringify({ items: [{ id: 'dev-1', name: 'South Wing', space_id: currentSpaceId }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      if (url.includes('/organization/spaces?') && url.includes('path_includes=Regional+Offices')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces?') && url.includes('id=99592')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/spaces')) {
        return new Response(JSON.stringify({ items: [{ id: 99592, name: 'South Wing' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/incidents') || url.includes('/organization/tickets')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/move') && (init?.method ?? 'GET') === 'POST') {
        currentSpaceId = 99592;
        return new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1')) {
        return new Response(JSON.stringify({ id: 'dev-1', name: 'South Wing', space_id: currentSpaceId }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const plan = await runDeterministicFlow({
        flowId: definition.id,
        tenantId: 'acme',
        mode: 'plan',
        outDir,
        context: {
          source_space_id: '900',
          target_path_includes: 'Regional Offices'
        },
        once: true,
        strictJson: true,
        profileStore,
        secretStore,
        client
      });

      await runDeterministicFlow({
        flowId: definition.id,
        tenantId: 'acme',
        mode: 'apply',
        outDir,
        resume: plan.runId,
        context: {},
        once: true,
        strictJson: true,
        profileStore,
        secretStore,
        client
      });

      const completed = await runDeterministicFlow({
        flowId: definition.id,
        tenantId: 'acme',
        mode: 'apply',
        outDir,
        resume: plan.runId,
        context: {},
        once: true,
        strictJson: true,
        profileStore,
        secretStore,
        client
      });

      expect(reportCalled).toBe(true);
      expect(completed.outcome).toBe('completed');
      expect(completed.steps.find((item) => item.stepId === 'post_migration_report')?.status).toBe('completed');
    } finally {
      reportSpy.mockRestore();
    }
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
        return new Response(
          JSON.stringify({ items: [{ id: 'pt-1', status: 'open', created_at: new Date().toISOString() }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
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
          command: 'xyte-cli ops inspect deep-dive --tenant <tenant-id>',
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
          command: 'xyte-cli ops report generate --tenant <tenant-id>',
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

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-provider-partner`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
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
          command: 'xyte-cli ops inspect deep-dive --tenant <tenant-id>',
          task: 'inspect.deep-dive',
          mutating: false,
          inspect: {
            mode: 'deep-dive',
            windowHours: 24
          }
        }
      ]
    };

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-resume-inspect-scope`);
    const first = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
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
      tenantId: 'acme',
      mode: 'apply',
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
        return new Response(
          JSON.stringify({ items: [{ id: 'pt-1', status: 'open', created_at: new Date().toISOString() }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
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
          command: 'xyte-cli ops inspect deep-dive --tenant <tenant-id>',
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
          command: 'xyte-cli ops report generate --tenant <tenant-id>',
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

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-resume-report`);
    const first = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
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
      tenantId: 'acme',
      mode: 'apply',
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
          command: 'xyte-cli ops report generate --tenant <tenant-id>',
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

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-report-parse-context`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
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
    expect(String(failedStep?.error?.detail ?? '')).toContain(
      'Step report_daily requires report-compatible output from status_fast.'
    );
    expect(String(failedStep?.error?.detail ?? '')).toContain(
      'Input JSON must be produced by `xyte-cli ops inspect deep-dive --output json`, `xyte-cli util match`, or `xyte-cli util move-devices`.'
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
          command: 'xyte-cli ops inspect deep-dive --tenant <tenant-id>',
          task: 'inspect.deep-dive',
          mutating: false,
          inspect: {
            mode: 'deep-dive',
            windowHours: 24
          }
        }
      ]
    };

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-provider-ambiguous`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
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
    expect(String(failedStep?.error?.detail ?? '')).toContain(
      'both organization and partner credentials are configured'
    );
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
          command: 'xyte-cli ops inspect fleet --tenant <tenant-id>',
          task: 'inspect.fleet',
          mutating: false,
          inspect: {
            mode: 'fleet'
          }
        }
      ]
    };

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-provider-ambiguous-fleet`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
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
    expect(String(failedStep?.error?.detail ?? '')).toContain(
      'both organization and partner credentials are configured'
    );
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
          command: 'xyte-cli ops inspect deep-dive --tenant <tenant-id>',
          task: 'inspect.deep-dive',
          mutating: false,
          inspect: {
            mode: 'deep-dive',
            windowHours: 24
          }
        }
      ]
    };

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-provider-explicit-unavailable-deep-dive`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
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
          command: 'xyte-cli ops inspect fleet --tenant <tenant-id>',
          task: 'inspect.fleet',
          mutating: false,
          inspect: {
            mode: 'fleet'
          }
        }
      ]
    };

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-provider-explicit-unavailable-fleet`);
    const result = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
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
          command: 'xyte-cli ops inspect fleet --tenant <tenant-id>',
          task: 'inspect.fleet',
          mutating: false,
          inspect: {
            mode: 'fleet'
          }
        }
      ]
    };

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-resume-explicit-scope-precedence`);
    const first = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
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
      tenantId: 'acme',
      mode: 'apply',
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
          command: 'xyte-cli ops inspect deep-dive --tenant <tenant-id>',
          task: 'inspect.deep-dive',
          mutating: false,
          inspect: {
            mode: 'deep-dive',
            windowHours: 24
          }
        }
      ]
    };

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-resume-malformed-scope`);
    const first = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
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
      tenantId: 'acme',
      mode: 'apply',
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
    expect(String(failedStep?.error?.detail ?? '')).toContain(
      'both organization and partner credentials are configured'
    );
  });

  it('sets <stepId>_output in context after space.import-tree step', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-space-import-tree-ctx`);
    const csvPath = join(tmpdir(), `space-import-tree-input-${Date.now()}.csv`);
    writeFileSync(csvPath, 'path\nBuilding A/Floor 1\n');

    const definition: BuiltInFlowDefinition = {
      id: 'flow.test-space-import' as BuiltInFlowId,
      title: 'Test Space Import',
      intent: 'test',
      writeCapable: true,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'import_tree',
          title: 'Import Space Tree',
          command: 'xyte-cli util import-tree',
          task: 'space.import-tree',
          mutating: true,
          spaceImportTree: {
            inputPath: csvPath,
            reportPath: 'import-tree-report.json',
            apply: false
          }
        }
      ]
    };

    builtInDefinitionOverride = definition;
    runSpaceImportTreeOverride = async () => ({
      schemaVersion: 'xyte.utility.batch.v1',
      generatedAtUtc: new Date().toISOString(),
      tenantId: 'acme',
      command: 'space.import-tree',
      mode: 'dry-run',
      totals: { rows: 1, succeeded: 1, failed: 0, skipped: 0 },
      stoppedEarly: false
    });

    const result = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {},
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(result.outcome).toBe('completed');
    const inputs = JSON.parse(readFileSync(result.inputsPath, 'utf8'));
    // <stepId>_output must be set so downstream steps can reference {{import_tree_output}}
    expect(inputs.context.import_tree_output).toBeDefined();
  });
});
