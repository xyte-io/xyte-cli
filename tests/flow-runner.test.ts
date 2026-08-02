import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createXyteClient } from '../src/client/create-client';
import {
  getBuiltInFlowDefinition,
  type BuiltInFlowDefinition,
  type BuiltInFlowId,
  type FlowTaskStep
} from '../src/workflows/flow-catalog';
import * as fleetInsights from '../src/workflows/fleet-insights';
import { runDeterministicFlow } from '../src/workflows/flow-runner';
import { UtilityBatchResultSchema } from '../src/workflows/utility-batch';
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
    hasBuiltInFlowDefinition: (id: string) =>
      builtInDefinitionOverride?.id === id || original.hasBuiltInFlowDefinition(id),
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
      if (url.includes('/organization/devices/dev-1') && !url.includes('/commands')) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', commands: [{ name: 'restart' }] }), {
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
          kind: 'task',
          id: 'command_device_get',
          title: 'Get Device For Command',
          command: 'xyte-cli api call organization.devices.getDevice',
          task: 'call',
          mutating: false,
          requiresContext: ['device_id'],
          call: {
            endpointKey: 'organization.devices.getDevice',
            path: { device_id: '{{device_id}}' },
            outputMode: 'envelope'
          }
        },
        {
          kind: 'task',
          id: 'command_model_describe',
          title: 'Describe Command Model',
          command: 'xyte-cli edge models describe',
          task: 'call',
          mutating: false,
          requiresContext: ['device_model_id'],
          call: {
            endpointKey: 'organization.models.getModel',
            path: { id: '{{device_model_id}}' },
            outputMode: 'envelope'
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

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/organization/incidents')) {
        return new Response(
          JSON.stringify({ items: [{ id: 'inc-1', uuid: 'inc-1', device_id: 'dev-1', status: 'active' }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      if (url.includes('/organization/devices/dev-1') && !url.includes('/commands')) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', commands: [{ name: 'restart' }] }), {
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
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ id: 'model-1', commands: [{ name: 'restart' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
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
          id: 'command_device_get',
          title: 'Get Device For Command',
          command: 'xyte-cli api call organization.devices.getDevice',
          task: 'call',
          mutating: false,
          requiresContext: ['device_id'],
          call: {
            endpointKey: 'organization.devices.getDevice',
            path: { device_id: '{{device_id}}' },
            outputMode: 'envelope'
          }
        },
        {
          kind: 'task',
          id: 'command_model_describe',
          title: 'Describe Command Model',
          command: 'xyte-cli edge models describe',
          task: 'call',
          mutating: false,
          requiresContext: ['device_model_id'],
          call: {
            endpointKey: 'organization.models.getModel',
            path: { id: '{{device_model_id}}' },
            outputMode: 'envelope'
          }
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      label: 'model metadata body.name used as a request selector',
      body: { name: '{{command}}' },
      expectedError: 'body.name is not supported'
    },
    {
      label: 'model metadata body.name with a non-string value',
      body: { name: null },
      expectedError: 'body.name is not supported'
    },
    {
      label: 'a non-string body.command',
      body: { command: 33 },
      expectedError: 'body.command to be a non-empty string'
    },
    {
      label: 'a blank body.command',
      body: { command: '   ' },
      expectedError: 'body.command to be a non-empty string'
    },
    {
      label: 'response-only body.params',
      body: { command: '{{command}}', params: { input: '33' } },
      expectedError: 'body.params is response-only data'
    },
    {
      label: 'non-object body.extra_params',
      body: { command: '{{command}}', extra_params: ['33'] },
      expectedError: 'requires body.extra_params to be a JSON object'
    }
  ])('rejects $label before calling the API', async ({ body, expectedError }) => {
    const { profileStore, secretStore, client } = await makeClient();
    const fetchMock = vi.fn(async () => {
      throw new Error('invalid sendCommand request body must fail before fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.guided-remediation',
      title: 'Legacy command body only',
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
            body,
            outputMode: 'envelope'
          }
        }
      ]
    };

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-invalid-command-body`);
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
    expect(String(result.steps.find((item) => item.stepId === 'send_command')?.error?.detail ?? '')).toContain(
      expectedError
    );
    expect(fetchMock).not.toHaveBeenCalled();
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
            items: currentSpaceId === 900 ? [{ id: 'dev-1', name: 'South Wing', space_id: 900 }] : []
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
            items: currentSpaceId === 900 ? [{ id: 'dev-1', name: 'South Wing', space_id: 900 }] : []
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

  it('pauses flow.edge-ping in plan mode before the mutating ping step', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.edge-ping');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-ping-plan`);

    const fetchMock = vi.fn(async () => {
      throw new Error('flow.edge-ping --plan must not call fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {
        proxy_id: 'proxy-1',
        device_ip: '192.168.1.10'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('pending_gate');
    expect(summary.cursor.nextStepId).toBe('gate_edge_ping');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(summary.steps.find((item) => item.stepId === 'gate_edge_ping')?.status).toBe('gate_pending');
    expect(summary.steps.find((item) => item.stepId === 'edge_ping_single')?.status).toBe('pending');
  });

  it('pauses flow.device-command after fetching model-supported commands', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-plan`);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.method ?? 'GET').toBe('GET');
      if (url.includes('/organization/devices/dev-1') && !url.includes('/commands')) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', commands: [{ name: 'reboot' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in flow.device-command plan test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {
        device_id: 'dev-1'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('pending_gate');
    expect(summary.cursor.nextStepId).toBe('gate_device_command_send');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(summary.steps.find((item) => item.stepId === 'device_command_device_get')?.status).toBe('completed');
    expect(summary.steps.find((item) => item.stepId === 'device_command_model_describe')?.status).toBe('completed');
    expect(summary.steps.find((item) => item.stepId === 'gate_device_command_send')?.status).toBe('gate_pending');
    expect(summary.steps.find((item) => item.stepId === 'device_command_send')?.status).toBe('pending');
    expect(summary.steps.find((item) => item.stepId === 'device_command_status')?.status).toBe('pending');
  });

  it('runs flow.device-command apply and polls the exact command id only when requested', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-apply`);
    const sentBodies: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ id: 'model-1', commands: [{ name: 'reboot' }, { name: 'identify' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: 'cmd-1', command: 'identify', status: 'pending' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'GET') {
        expect(url).toContain('page=1');
        expect(url).toContain('per_page=500');
        return new Response(
          JSON.stringify({
            items: [
              { id: 'other-command', status: 'done' },
              { id: 'cmd-1', status: 'done' }
            ],
            has_next_page: false
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      throw new Error(`Unexpected URL in flow.device-command apply test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_id: 'dev-1',
        command: 'identify',
        command_poll: 'true',
        command_poll_timeout_ms: '100',
        command_poll_interval_ms: '1'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sentBodies).toEqual([{ command: 'identify' }]);
    expect(summary.steps.map((item) => item.status)).toEqual([
      'completed',
      'completed',
      'gate_approved',
      'completed',
      'completed'
    ]);
    const statusStep = summary.steps.find((item) => item.stepId === 'device_command_status');
    expect(statusStep?.artifactPath).toBeDefined();
    expect(JSON.parse(readFileSync(statusStep!.artifactPath!, 'utf8'))).toMatchObject({
      commandId: 'cmd-1',
      outcome: 'done',
      attempts: 1
    });
  });

  it('skips status checking when disabled, even if unused polling values are invalid', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-no-poll`);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ id: 'model-1', commands: [{ name: 'reboot' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        return new Response(JSON.stringify({ status: 'pending' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'GET') {
        throw new Error('disabled command status checking must not call command history');
      }
      throw new Error(`Unexpected URL in flow.device-command no-poll test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_id: 'dev-1',
        command: 'reboot',
        command_poll: ' FALSE ',
        command_poll_timeout_ms: 'not-a-number',
        command_poll_interval_ms: '0'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const statusStep = summary.steps.find((item) => item.stepId === 'device_command_status');
    expect(JSON.parse(readFileSync(statusStep!.artifactPath!, 'utf8'))).toEqual({ outcome: 'not_requested' });
  });

  it.each([
    {
      label: 'the send response has no unique command id',
      sendPayload: { status: 'pending' },
      historyPayload: undefined,
      timeoutMs: '100',
      expectedError: 'could not read a command id',
      expectedCalls: 3,
      historyError: undefined
    },
    {
      label: 'the exact command fails',
      sendPayload: { id: 'cmd-1', status: 'pending' },
      historyPayload: { items: [{ id: 'cmd-1', status: 'failed' }], has_next_page: false },
      timeoutMs: '100',
      expectedError: 'ended with status failed',
      expectedCalls: 4,
      historyError: undefined
    },
    {
      label: 'the exact command is aborted',
      sendPayload: { id: 'cmd-1', status: 'pending' },
      historyPayload: { items: [{ id: 'cmd-1', status: 'aborted' }], has_next_page: false },
      timeoutMs: '100',
      expectedError: 'ended with status aborted',
      expectedCalls: 4,
      historyError: undefined
    },
    {
      label: 'the exact command remains pending until timeout',
      sendPayload: { id: 'cmd-1', status: 'pending' },
      historyPayload: { items: [{ id: 'cmd-1', status: 'pending' }], has_next_page: false },
      timeoutMs: '1',
      expectedError: 'status polling timed out',
      expectedCalls: undefined,
      historyError: undefined
    },
    {
      label: 'command history cannot be read',
      sendPayload: { id: 'cmd-1', status: 'pending' },
      historyPayload: undefined,
      timeoutMs: '100',
      expectedError: 'command history unavailable',
      expectedCalls: 4,
      historyError: 'command history unavailable'
    }
  ])(
    'reports a failed status step when $label',
    async ({ sendPayload, historyPayload, timeoutMs, expectedError, expectedCalls, historyError }) => {
      const { profileStore, secretStore, client } = await makeClient();
      const definition = getBuiltInFlowDefinition('flow.device-command');
      builtInDefinitionOverride = definition;
      const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-poll-failure`);

      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (
          url.includes('/organization/devices/dev-1') &&
          !url.includes('/commands') &&
          (init?.method ?? 'GET') === 'GET'
        ) {
          return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
          return new Response(JSON.stringify({ id: 'model-1', commands: [{ name: 'reboot' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
          return new Response(JSON.stringify(sendPayload), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'GET') {
          if (historyError) {
            throw new Error(historyError);
          }
          if (historyPayload === undefined) {
            throw new Error('status checking must not start without a unique command id');
          }
          return new Response(JSON.stringify(historyPayload), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        throw new Error(`Unexpected URL in flow.device-command poll-failure test: ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const summary = await runDeterministicFlow({
        flowId: definition.id,
        tenantId: 'acme',
        mode: 'apply',
        outDir,
        context: {
          device_id: 'dev-1',
          command: 'reboot',
          command_poll: 'true',
          command_poll_timeout_ms: timeoutMs,
          command_poll_interval_ms: '1'
        },
        once: true,
        strictJson: true,
        profileStore,
        secretStore,
        client
      });

      expect(summary.outcome).toBe('failed');
      const statusStep = summary.steps.find((item) => item.stepId === 'device_command_status');
      expect(statusStep?.status).toBe('failed');
      expect(String(statusStep?.error?.detail ?? '')).toContain(expectedError);
      if (expectedCalls === undefined) {
        expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      } else {
        expect(fetchMock).toHaveBeenCalledTimes(expectedCalls);
      }
    }
  );

  it('maps model option labels and arrays to canonical extra_params values before sending', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-params`);
    const sentBodies: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'model-1',
            commands: [
              {
                name: 'set_input',
                custom_fields: [
                  {
                    name: 'input',
                    type: 'select',
                    title: 'Value',
                    required: true,
                    typeName: 'staticListSingle',
                    options: {
                      '33': 'HDMI 1',
                      '35': 'HDMI 2'
                    }
                  },
                  {
                    name: 'zones',
                    type: 'multiselect',
                    title: 'Zones',
                    required: true,
                    typeName: 'staticListMulti',
                    options: {
                      lobby: { label: 'Lobby', order: 0, value: 'lobby' },
                      auditorium: { label: 'Auditorium', order: 1, value: 'auditorium' }
                    }
                  }
                ]
              }
            ]
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: 'cmd-1', name: 'set_input' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in flow.device-command params test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_id: 'dev-1',
        command: 'set_input',
        command_extra_params_json: '{"input":"HDMI 1","zones":["Lobby","auditorium"]}'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sentBodies).toEqual([
      { command: 'set_input', extra_params: { input: '33', zones: ['lobby', 'auditorium'] } }
    ]);
    expect(summary.steps.find((item) => item.stepId === 'device_command_status')?.status).toBe('completed');
  });

  it.each([
    {
      label: 'an array supplied for a static single-value field',
      field: {
        name: 'zones',
        type: 'select',
        typeName: 'staticListSingle',
        required: true,
        options: { lobby: { label: 'Lobby', value: 'lobby' } }
      },
      supplied: ['Lobby'],
      expectedError: 'wrong scalar/array shape'
    },
    {
      label: 'a scalar supplied for a static multi-value field',
      field: {
        name: 'zones',
        type: 'multiselect',
        typeName: 'staticListMulti',
        required: true,
        options: { lobby: { label: 'Lobby', value: 'lobby' } }
      },
      supplied: 'Lobby',
      expectedError: 'wrong scalar/array shape'
    },
    {
      label: 'an empty array supplied for a required multi-value field',
      field: {
        name: 'zones',
        type: 'multiselect',
        typeName: 'staticListMulti',
        required: true,
        options: { lobby: { label: 'Lobby', value: 'lobby' } }
      },
      supplied: [],
      expectedError: 'requires extra_params field(s): zones'
    },
    {
      label: 'an empty string supplied for a required single-value field',
      field: {
        name: 'zones',
        type: 'select',
        typeName: 'staticListSingle',
        required: true,
        options: { lobby: { label: 'Lobby', value: 'lobby' } }
      },
      supplied: '',
      expectedError: 'requires extra_params field(s): zones'
    },
    {
      label: 'null supplied for a required single-value field',
      field: {
        name: 'zones',
        type: 'select',
        typeName: 'staticListSingle',
        required: true,
        options: { lobby: { label: 'Lobby', value: 'lobby' } }
      },
      supplied: null,
      expectedError: 'requires extra_params field(s): zones'
    },
    {
      label: 'an unknown member supplied for a static multi-value field',
      field: {
        name: 'zones',
        type: 'multiselect',
        typeName: 'staticListMulti',
        required: true,
        options: { lobby: { label: 'Lobby', value: 'lobby' } }
      },
      supplied: ['Lobby', 'Missing'],
      expectedError: 'an unknown value'
    },
    {
      label: 'a value supplied for unresolved path-backed options',
      field: {
        name: 'zones',
        type: 'multiselect',
        typeName: 'dynamicListMulti',
        required: true,
        path: 'details.available_zones'
      },
      supplied: ['Lobby'],
      expectedError: 'uses path-backed options'
    },
    {
      label: 'a value supplied when a multi-value field omits its choices',
      field: {
        name: 'zones',
        type: 'multiselect',
        typeName: 'staticListMulti',
        required: true
      },
      supplied: ['Lobby'],
      expectedError: 'invalid or ambiguous options metadata'
    },
    {
      label: 'a value supplied when the option container is malformed',
      field: {
        name: 'zones',
        type: 'select',
        typeName: 'staticListSingle',
        required: true,
        options: 'not-an-option-container'
      },
      supplied: 'Lobby',
      expectedError: 'invalid or ambiguous options metadata'
    },
    {
      label: 'a value supplied when the model defines no choices',
      field: {
        name: 'zones',
        type: 'select',
        typeName: 'staticListSingle',
        required: true,
        options: {}
      },
      supplied: 'Lobby',
      expectedError: 'invalid or ambiguous options metadata'
    }
  ])('blocks $label before sending', async ({ field, supplied, expectedError }) => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-option-shape`);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({ id: 'model-1', commands: [{ name: 'route_audio', custom_fields: [field] }] }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        throw new Error('flow.device-command must not POST invalid option-backed parameters');
      }
      throw new Error(`Unexpected URL in flow.device-command option-shape test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_id: 'dev-1',
        command: 'route_audio',
        command_extra_params_json: JSON.stringify({ zones: supplied })
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('needs_input');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(summary.steps.find((item) => item.stepId === 'device_command_send')?.error?.detail ?? '')).toContain(
      expectedError
    );
  });

  it.each([
    {
      label: 'malformed command parameter JSON',
      modelCommand: { name: 'set_mode', custom_fields: [{ name: 'mode' }] },
      rawParams: '{"mode":',
      expectedError: 'must be a valid JSON object'
    },
    {
      label: 'a command parameter JSON array',
      modelCommand: { name: 'set_mode', custom_fields: [{ name: 'mode' }] },
      rawParams: '["automatic"]',
      expectedError: 'must be a valid JSON object'
    },
    {
      label: 'parameters for a command with no custom fields',
      modelCommand: { name: 'set_mode' },
      rawParams: '{"mode":"automatic"}',
      expectedError: 'does not define custom_fields'
    },
    {
      label: 'a parameter name not declared by the model command',
      modelCommand: { name: 'set_mode', custom_fields: [{ name: 'mode' }] },
      rawParams: '{"unexpected":"automatic"}',
      expectedError: 'does not define extra_params field(s): unexpected'
    }
  ])('blocks $label before sending', async ({ modelCommand, rawParams, expectedError }) => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-invalid-params`);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ id: 'model-1', commands: [modelCommand] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        throw new Error('flow.device-command must not POST invalid command parameters');
      }
      throw new Error(`Unexpected URL in flow.device-command invalid-params test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_id: 'dev-1',
        command: 'set_mode',
        command_extra_params_json: rawParams
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('needs_input');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(summary.steps.find((item) => item.stepId === 'device_command_send')?.error?.detail ?? '')).toContain(
      expectedError
    );
  });

  it.each([
    {
      label: 'duplicate command names',
      modelCommands: [
        { name: 'set_mode', custom_fields: [{ name: 'mode', required: true }] },
        { name: 'set_mode', custom_fields: [{ name: 'mode', required: false }] }
      ],
      expectedError: 'command name "set_mode" is ambiguous'
    },
    {
      label: 'duplicate custom field names',
      modelCommands: [
        {
          name: 'set_mode',
          custom_fields: [
            { name: 'mode', required: true },
            { name: 'mode', required: false }
          ]
        }
      ],
      expectedError: 'custom_fields contains duplicate name "mode"'
    },
    {
      label: 'a malformed custom fields collection',
      modelCommands: [{ name: 'set_mode', custom_fields: { name: 'mode' } }],
      expectedError: 'custom_fields must be an array'
    },
    {
      label: 'a malformed custom field entry',
      modelCommands: [{ name: 'set_mode', custom_fields: [null] }],
      expectedError: 'custom_fields entry 1 is invalid'
    },
    {
      label: 'a non-boolean required flag',
      modelCommands: [{ name: 'set_mode', custom_fields: [{ name: 'mode', required: 'true' }] }],
      expectedError: 'required flag must be a boolean'
    },
    {
      label: 'a non-boolean file requirement',
      modelCommands: [{ name: 'set_mode', with_file: 'true' }],
      expectedError: 'with_file must be a boolean'
    }
  ])('blocks $label in model command metadata before sending', async ({ modelCommands, expectedError }) => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-invalid-model-metadata`);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ id: 'model-1', commands: modelCommands }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        throw new Error('flow.device-command must not POST ambiguous or malformed model metadata');
      }
      throw new Error(`Unexpected URL in flow.device-command invalid-model-metadata test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: { device_id: 'dev-1', command: 'set_mode' },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('needs_input');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(summary.steps.find((item) => item.stepId === 'device_command_send')?.error?.detail ?? '')).toContain(
      expectedError
    );
  });

  it('allows an optional model-backed choice to be omitted', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-optional-param`);
    const sentBodies: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'model-1',
            commands: [
              {
                name: 'set_mode',
                custom_fields: [
                  {
                    name: 'mode',
                    type: 'select',
                    typeName: 'staticListSingle',
                    options: { automatic: { label: 'Automatic', value: 'automatic' } }
                  }
                ]
              }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: 'cmd-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in flow.device-command optional-param test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: { device_id: 'dev-1', command: 'set_mode' },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('completed');
    expect(sentBodies).toEqual([{ command: 'set_mode' }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([
    {
      label: 'accepts a unique friendly name',
      modelCommands: [{ name: 'reboot', friendly_name: 'Restart device' }],
      body: { friendly_name: '{{friendly_name}}' },
      context: { friendly_name: 'Restart device' },
      expectedBody: { friendly_name: 'Restart device' },
      expectedError: undefined
    },
    {
      label: 'accepts nullable no-parameter command metadata',
      modelCommands: [{ name: 'reboot', custom_fields: null, with_file: null }],
      body: { command: '{{command}}' },
      context: { command: 'reboot' },
      expectedBody: { command: 'reboot' },
      expectedError: undefined
    },
    {
      label: 'trims a unique command name before sending',
      modelCommands: [{ name: 'reboot' }],
      body: { command: '{{command}}' },
      context: { command: '  reboot  ' },
      expectedBody: { command: 'reboot' },
      expectedError: undefined
    },
    {
      label: 'trims a unique friendly name before sending',
      modelCommands: [{ name: 'reboot', friendly_name: 'Restart device' }],
      body: { friendly_name: '{{friendly_name}}' },
      context: { friendly_name: '  Restart device  ' },
      expectedBody: { friendly_name: 'Restart device' },
      expectedError: undefined
    },
    {
      label: 'rejects a duplicate friendly name',
      modelCommands: [
        { name: 'reboot', friendly_name: 'Restart device' },
        { name: 'power_cycle', friendly_name: 'Restart device' }
      ],
      body: { friendly_name: '{{friendly_name}}' },
      context: { friendly_name: 'Restart device' },
      expectedBody: undefined,
      expectedError: 'friendly_name "Restart device" is ambiguous'
    },
    {
      label: 'rejects name and friendly name selectors for different commands',
      modelCommands: [
        { name: 'reboot', friendly_name: 'Restart device' },
        { name: 'identify', friendly_name: 'Identify device' }
      ],
      body: { command: '{{command}}', friendly_name: '{{friendly_name}}' },
      context: { command: 'reboot', friendly_name: 'Identify device' },
      expectedBody: undefined,
      expectedError: 'identify different model commands'
    }
  ])('$label', async ({ modelCommands, body, context, expectedBody, expectedError }) => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = structuredClone(getBuiltInFlowDefinition('flow.device-command'));
    const sendStep = definition.steps.find(
      (step): step is FlowTaskStep => step.kind === 'task' && step.id === 'device_command_send'
    );
    expect(sendStep?.call).toBeDefined();
    sendStep!.requiresContext = ['device_id', ...Object.keys(context)];
    sendStep!.call = { ...sendStep!.call!, body };
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-friendly-name`);
    const sentBodies: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ id: 'model-1', commands: modelCommands }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: 'cmd-1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in flow.device-command friendly-name test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: { device_id: 'dev-1', ...(context as Record<string, string>) },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    if (expectedError) {
      expect(summary.outcome).toBe('needs_input');
      expect(sentBodies).toEqual([]);
      expect(
        String(summary.steps.find((item) => item.stepId === 'device_command_send')?.error?.detail ?? '')
      ).toContain(expectedError);
    } else {
      expect(summary.outcome).toBe('completed');
      expect(sentBodies).toEqual([expectedBody]);
    }
  });

  it('blocks ambiguous model select mappings before sending', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-ambiguous-options`);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(
          JSON.stringify({
            id: 'model-1',
            commands: [
              {
                name: 'set_mode',
                custom_fields: [
                  {
                    name: 'mode',
                    type: 'select',
                    required: true,
                    options: {
                      foo: { label: 'Primary', value: 'foo' },
                      bar: { label: 'foo', value: 'bar' }
                    }
                  }
                ]
              }
            ]
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' }
          }
        );
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        throw new Error('flow.device-command must not POST an ambiguous select mapping');
      }
      throw new Error(`Unexpected URL in flow.device-command ambiguous-options test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_id: 'dev-1',
        command: 'set_mode',
        command_extra_params_json: '{"mode":"foo"}'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('needs_input');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(summary.steps.find((item) => item.stepId === 'device_command_send')?.error?.detail ?? '')).toContain(
      'an ambiguous value'
    );
  });

  it.each([
    {
      label: 'a missing timeout',
      pollContext: { command_poll: 'true' },
      expectedError: 'command_poll_timeout_ms is required'
    },
    {
      label: 'an invalid enabled flag',
      pollContext: { command_poll: 'sometimes' },
      expectedError: 'command_poll must be true or false'
    },
    {
      label: 'a non-positive timeout',
      pollContext: { command_poll: 'true', command_poll_timeout_ms: '0' },
      expectedError: 'command_poll_timeout_ms must be a positive integer'
    },
    {
      label: 'a non-integer timeout',
      pollContext: { command_poll: 'true', command_poll_timeout_ms: '1.5' },
      expectedError: 'command_poll_timeout_ms must be a positive integer'
    },
    {
      label: 'a timeout above the timer limit',
      pollContext: { command_poll: 'true', command_poll_timeout_ms: '2147483648' },
      expectedError: 'command_poll_timeout_ms must be no greater than 2147483647'
    },
    {
      label: 'a non-positive interval',
      pollContext: {
        command_poll: 'true',
        command_poll_timeout_ms: '100',
        command_poll_interval_ms: '-1'
      },
      expectedError: 'command_poll_interval_ms must be a positive integer'
    },
    {
      label: 'an interval above the timer limit',
      pollContext: {
        command_poll: 'true',
        command_poll_timeout_ms: '100',
        command_poll_interval_ms: '2147483648'
      },
      expectedError: 'command_poll_interval_ms must be no greater than 2147483647'
    }
  ])('validates $label before sending', async ({ pollContext, expectedError }) => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-poll-bounds`);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ id: 'model-1', commands: [{ name: 'reboot' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        throw new Error('flow.device-command must not POST before validating polling bounds');
      }
      throw new Error(`Unexpected URL in flow.device-command poll-bounds test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_id: 'dev-1',
        command: 'reboot',
        ...(pollContext as Record<string, string>)
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('needs_input');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(summary.steps.find((item) => item.stepId === 'device_command_send')?.error?.detail ?? '')).toContain(
      expectedError
    );
  });

  it('passes command_file_id when the model command requires a file', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-file`);
    const sentBodies: Array<Record<string, unknown>> = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ id: 'model-1', commands: [{ name: 'upload', with_file: true }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        sentBodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: 'cmd-1', name: 'upload' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in flow.device-command file test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_id: 'dev-1',
        command: 'upload',
        command_file_id: 'file-1'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('completed');
    expect(sentBodies).toEqual([{ command: 'upload', file_id: 'file-1' }]);
  });

  it.each([
    { label: 'is omitted', fileId: undefined },
    { label: 'contains only whitespace', fileId: '   ' }
  ])('blocks flow.device-command when a required file id $label', async ({ fileId }) => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-missing-file`);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ id: 'model-1', commands: [{ name: 'upload', with_file: true }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        throw new Error('flow.device-command must not POST a file-required command without file_id');
      }
      throw new Error(`Unexpected URL in flow.device-command missing-file test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const context: Record<string, string> = {
      device_id: 'dev-1',
      command: 'upload'
    };
    if (fileId !== undefined) context.command_file_id = fileId;

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context,
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('needs_input');
    expect(String(summary.steps.find((item) => item.stepId === 'device_command_send')?.error?.detail ?? '')).toContain(
      'requires command_file_id/file_id'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('blocks flow.device-command when required command params are missing', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-missing-param`);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (
          url.includes('/organization/devices/dev-1') &&
          !url.includes('/commands') &&
          (init?.method ?? 'GET') === 'GET'
        ) {
          return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
        if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
          return new Response(
            JSON.stringify({
              id: 'model-1',
              commands: [{ name: 'identify', custom_fields: [{ name: 'delay', required: true }] }]
            }),
            {
              status: 200,
              headers: { 'content-type': 'application/json' }
            }
          );
        }
        if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
          throw new Error('flow.device-command must not POST without required custom_fields');
        }
        throw new Error(`Unexpected URL in flow.device-command missing-param test: ${url}`);
      })
    );

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_id: 'dev-1',
        command: 'identify'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('needs_input');
    expect(String(summary.steps.find((item) => item.stepId === 'device_command_send')?.error?.detail ?? '')).toContain(
      'requires extra_params'
    );
  });

  it('blocks flow.device-command apply when the selected command is not in fetched evidence', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-invalid`);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ id: 'model-1', commands: [{ name: 'reboot' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        throw new Error('flow.device-command must not POST a command that was not fetched');
      }
      throw new Error(`Unexpected URL in flow.device-command invalid test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_id: 'dev-1',
        command: 'identify'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('needs_input');
    expect(summary.steps.find((item) => item.stepId === 'device_command_send')?.status).toBe('failed');
    expect(String(summary.steps.find((item) => item.stepId === 'device_command_send')?.error?.detail ?? '')).toContain(
      'was not found'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not treat model commands[].command as supported-command evidence', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.device-command');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-device-command-no-legacy-model-command`);

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.includes('/organization/devices/dev-1') &&
        !url.includes('/commands') &&
        (init?.method ?? 'GET') === 'GET'
      ) {
        return new Response(JSON.stringify({ id: 'dev-1', model: { id: 'model-1' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/models/model-1') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ id: 'model-1', commands: [{ command: 'identify' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/organization/devices/dev-1/commands') && (init?.method ?? 'GET') === 'POST') {
        throw new Error('flow.device-command must not POST commands[].command aliases');
      }
      throw new Error(`Unexpected URL in flow.device-command legacy model command test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_id: 'dev-1',
        command: 'identify'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('needs_input');
    expect(String(summary.steps.find((item) => item.stepId === 'device_command_send')?.error?.detail ?? '')).toContain(
      'requires supported-command evidence'
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('pauses flow.edge-claim after model discovery and before the mutating claim step', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition = getBuiltInFlowDefinition('flow.edge-claim');
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-claim-plan`);

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models?')) {
        expect(url).toContain('edge_only=true');
        return new Response(JSON.stringify({ items: [{ id: 'model-from-list', model: 'Sensor' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [{ name: 'Port', type: 'number' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in flow.edge-claim plan test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {
        proxy_id: 'proxy-1',
        device_ip: '192.168.1.10',
        device_model_id: 'model-1',
        space_id: '99'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('pending_gate');
    expect(summary.cursor.nextStepId).toBe('gate_edge_claim');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(summary.steps.find((item) => item.stepId === 'edge_claim_models_list')?.status).toBe('completed');
    expect(summary.steps.find((item) => item.stepId === 'edge_claim_model_describe')?.status).toBe('completed');
    expect(summary.steps.find((item) => item.stepId === 'gate_edge_claim')?.status).toBe('gate_pending');
    expect(summary.steps.find((item) => item.stepId === 'edge_claim_single')?.status).toBe('pending');
  });

  it('runs flow.edge-model-discovery through model list and describe calls', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-model-discovery`);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models?')) {
        expect(url).toContain('edge_only=true');
        return new Response(JSON.stringify({ items: [{ id: 'model-1', model: 'Sensor' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [{ name: 'Port', type: 'number' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge-model-discovery flow test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: 'flow.edge-model-discovery',
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

    expect(summary.outcome).toBe('completed');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(summary.steps.map((step) => step.status)).toEqual(['completed', 'completed']);
  });

  it('pauses flow.edge-model-discovery when the model list is ambiguous', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-model-discovery-ambiguous`);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models?')) {
        return new Response(JSON.stringify({ items: [{ id: 'model-1' }, { id: 'model-2' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in ambiguous edge-model-discovery flow test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: 'flow.edge-model-discovery',
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

    expect(summary.outcome).toBe('needs_input');
    expect(summary.classifications.needs_data).toBe(1);
    expect(summary.classifications.bug).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(summary.steps.find((item) => item.stepId === 'edge_model_describe')?.status).toBe('failed');
  });

  it.each([
    { label: 'absent', contextValue: undefined, expected: undefined },
    { label: 'true', contextValue: 'true', expected: true },
    { label: 'false', contextValue: 'false', expected: false }
  ])('flow.edge-claim apply preserves skip_connectivity_check $label context', async ({ contextValue, expected }) => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition: BuiltInFlowDefinition = {
      id: 'flow.edge-claim',
      title: 'Edge Claim Apply Test',
      intent: 'test edge claim apply body',
      writeCapable: true,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'edge_claim_single',
          title: 'Edge Claim Single',
          task: 'edge.claim',
          edgeClaim: {},
          requiresContext: ['proxy_id', 'device_ip', 'device_model_id', 'space_id'],
          mutating: true,
          command:
            'xyte-cli edge claim --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --device-model-id <model-id> --space-id <space-id> --apply'
        }
      ]
    };
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-claim-apply`);
    const bodies: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/core/v1/organization/edges/devices/start_claim')) {
        bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        return new Response(null, { status: 204 });
      }
      if (url.includes('/core/v1/organization/edges/devices/get_claim_status')) {
        return new Response(JSON.stringify({ result: 'success' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge-claim flow test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const context: Record<string, string> = {
      proxy_id: 'proxy-1',
      device_ip: '192.168.1.10',
      device_model_id: 'model-1',
      space_id: '99',
      mac: 'aa:bb:cc:dd:ee:ff',
      sn: 'SN-12345'
    };
    if (contextValue !== undefined) {
      context.skip_connectivity_check = contextValue;
    }

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context,
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('completed');
    if (expected === undefined) {
      expect(bodies[0]).not.toHaveProperty('skip_connectivity_check');
    } else {
      expect(bodies[0]?.skip_connectivity_check).toBe(expected);
    }
    expect(bodies[0]).toMatchObject({ mac: 'aa:bb:cc:dd:ee:ff', sn: 'SN-12345' });
  });

  it('plans flow.edge-params-update and pauses before the apply gate', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-params-update`);
    const methods: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      methods.push(String(init?.method ?? 'GET'));
      if (url.includes('/core/v1/organization/devices/dev-1')) {
        return new Response(
          JSON.stringify({
            id: 'dev-1',
            model: { id: 'model-1' },
            custom_parameters: { Port: '162' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [{ name: 'Port', type: 'number' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge-params-update flow test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: 'flow.edge-params-update',
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: { device_id: 'dev-1', set_json: '{"Port":"161"}' },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('pending_gate');
    expect(summary.cursor.nextStepId).toBe('gate_edge_params_apply');
    expect(methods).toEqual(['GET', 'GET']);
    expect(summary.steps.find((item) => item.stepId === 'edge_params_plan')?.status).toBe('completed');
  });

  it('classifies flow.edge-params-update rejected input as needs_input', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-params-update-rejected`);
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/devices/dev-1')) {
        return new Response(
          JSON.stringify({
            id: 'dev-1',
            model: { id: 'model-1' },
            custom_parameters: { Port: '162' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [{ name: 'Port', type: 'number' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge-params-update rejected flow test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: 'flow.edge-params-update',
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: { device_id: 'dev-1', set_json: '{"Unknown":true}' },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('needs_input');
    expect(summary.classifications.needs_data).toBe(1);
    expect(summary.classifications.bug).toBe(0);
  });

  it('classifies flow edge params batch row rejects as needs_input', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const root = mkdtempSync(join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-params-batch-rejected`));
    const inputPath = join(root, 'edge-params.csv');
    const outDir = join(root, 'runs');
    writeFileSync(inputPath, 'device_id,set_json\n' + 'dev-1,"{""Unknown"":true}"\n');
    const definition: BuiltInFlowDefinition = {
      id: 'flow.edge-params-update-batch',
      title: 'Edge Params Batch Reject Test',
      intent: 'test batch rejected classification',
      writeCapable: true,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'edge_params_dry_run',
          title: 'Dry Run',
          task: 'edge.params-update-batch',
          edgeParamsUpdateBatch: {
            inputPath: '{{edge_params_input_path}}',
            apply: false,
            reportPath: './artifacts/edge-params.plan.ndjson',
            resumePath: './artifacts/edge-params.resume.ndjson'
          },
          requiresContext: ['edge_params_input_path'],
          mutating: false,
          command: 'xyte-cli edge update-params-batch --plan'
        }
      ]
    };
    builtInDefinitionOverride = definition;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/devices/dev-1')) {
        return new Response(
          JSON.stringify({
            id: 'dev-1',
            model: { id: 'model-1' },
            custom_parameters: { Port: '162' }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [{ name: 'Port', type: 'number' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge-params-update-batch rejected flow test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: { edge_params_input_path: inputPath },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('needs_input');
    expect(summary.classifications.needs_data).toBe(1);
    expect(summary.classifications.bug).toBe(0);
  });

  it('classifies edge claim batch validation rejects as needs_input', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const root = mkdtempSync(join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-claim-batch-rejected`));
    const inputPath = join(root, 'edge-claim.csv');
    const outDir = join(root, 'runs');
    writeFileSync(inputPath, 'proxy_id,device_ip,device_model_id,space_id\n,192.168.1.10,model-1,space-1\n');
    const definition: BuiltInFlowDefinition = {
      id: 'flow.edge-claim-batch',
      title: 'Edge Claim Batch Reject Test',
      intent: 'test claim batch rejected classification',
      writeCapable: true,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'edge_claim_dry_run',
          title: 'Dry Run',
          task: 'edge.claim-batch',
          edgeClaimBatch: {
            inputPath: '{{edge_claim_input_path}}',
            apply: false,
            reportPath: './artifacts/edge-claim.plan.ndjson',
            resumePath: './artifacts/edge-claim.resume.ndjson'
          },
          requiresContext: ['edge_claim_input_path'],
          mutating: false,
          command: 'xyte-cli edge claim-batch --plan'
        }
      ]
    };
    builtInDefinitionOverride = definition;
    const fetchMock = vi.fn(async () => {
      throw new Error('edge claim validation rejects must not call the API');
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: { edge_claim_input_path: inputPath },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('needs_input');
    expect(summary.classifications.needs_data).toBe(1);
    expect(summary.classifications.bug).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pauses flow.edge-params-update-batch after preparing the CSV scaffold', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const root = mkdtempSync(join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-params-batch`));
    const inputPath = join(root, 'edge-params.xlsx');
    const outDir = join(root, 'runs');
    writeFileSync(inputPath, 'source', 'utf8');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: 'flow.edge-params-update-batch',
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: { edge_params_input_path: inputPath },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('pending_gate');
    expect(summary.cursor.nextStepId).toBe('gate_edge_params_prepare_review');
    const prepareStep = summary.steps.find((item) => item.stepId === 'edge_params_prepare');
    expect(prepareStep?.status).toBe('completed');
    expect(prepareStep?.artifactPath).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(prepareStep!.artifactPath!, 'utf8')).toContain('edge-params-update.csv');
  });

  it('reports the resolved custom poll key name when edge poll timing is invalid', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition: BuiltInFlowDefinition = {
      id: 'flow.edge-ping',
      title: 'Edge Ping Key Labels',
      intent: 'test custom poll key labels',
      writeCapable: false,
      recipeCommands: [],
      steps: [
        {
          kind: 'task',
          id: 'edge_ping_single',
          title: 'Edge Ping Single',
          task: 'edge.ping',
          mutating: true,
          requiresContext: ['proxy_id', 'device_ip', 'custom_interval'],
          edgePing: {
            pollIntervalMsKey: 'custom_interval'
          },
          command: 'xyte-cli edge ping --tenant <tenant-id> --proxy-id <proxy-id> --device-ip <device-ip> --apply'
        }
      ]
    };
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-ping-custom-key`);

    const fetchMock = vi.fn(async () => {
      throw new Error('invalid poll config must fail before fetch');
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runDeterministicFlow({
      flowId: definition.id,
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        proxy_id: 'proxy-1',
        device_ip: '192.168.1.10',
        custom_interval: '10s'
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(summary.outcome).toBe('failed');
    expect(fetchMock).not.toHaveBeenCalled();
    const failedStep = summary.steps.find((item) => item.stepId === 'edge_ping_single');
    expect(failedStep?.status).toBe('failed');
    expect(String(failedStep?.error?.detail ?? '')).toContain('custom_interval');
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
    const outDir = join(tmpdir(), `xyte flow runner ${Date.now()} resume inspect scope`);
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
    const expectedOutDirArg = process.platform === 'win32' ? `"${outDir}"` : `'${outDir}'`;
    expect(first.resumeCommand).toContain(`--out-dir ${expectedOutDirArg}`);
    expect(first.resumeCommand).toContain('--apply');
    expect(first.nextAction).toMatchObject({
      kind: 'approve_gate',
      stepId: 'gate_1',
      title: 'Approval',
      requiresWrite: true,
      command: first.resumeCommand
    });

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
    expect(second.nextAction).toBeUndefined();
    expect(second.steps.find((item) => item.stepId === 'inspect_deep_dive_daily')?.status).toBe('completed');
    const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledUrls.length).toBeGreaterThan(0);
    expect(calledUrls.every((url) => url.includes('/partner/'))).toBe(true);
  });

  it('uses Windows argument quoting in generated resume commands on Windows', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    if (!platformDescriptor) {
      throw new Error('process.platform descriptor missing');
    }

    const definition: BuiltInFlowDefinition = {
      id: 'flow.setup-readiness-10m',
      title: 'Windows Resume Command',
      intent: 'resume command should be copy-pasteable on Windows',
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
        }
      ]
    };

    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte flow runner ${Date.now()} windows resume`);
    try {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
      const first = await runDeterministicFlow({
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

      expect(first.outcome).toBe('pending_gate');
      expect(first.resumeCommand).toContain(`--out-dir "${outDir}"`);
      expect(first.resumeCommand).not.toContain(`--out-dir '${outDir}'`);
      expect(first.nextAction?.command).toBe(first.resumeCommand);
    } finally {
      Object.defineProperty(process, 'platform', platformDescriptor);
    }
  });

  it('fails closed when resume inputs metadata is malformed', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const definition: BuiltInFlowDefinition = {
      id: 'flow.setup-readiness-10m',
      title: 'Malformed resume inputs',
      intent: 'reject malformed stored inputs',
      writeCapable: true,
      recipeCommands: [],
      steps: [
        {
          kind: 'gate',
          id: 'gate_1',
          title: 'Approval',
          command: 'Human gate',
          mutating: false,
          detail: 'approve resume'
        },
        {
          kind: 'task',
          id: 'status_fast',
          title: 'Status Fast',
          command: 'xyte-cli status',
          task: 'status.fast',
          mutating: false
        }
      ]
    };
    builtInDefinitionOverride = definition;
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-malformed-resume-inputs`);

    const first = await runDeterministicFlow({
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
    writeFileSync(first.inputsPath, '{not-json', 'utf8');

    await expect(
      runDeterministicFlow({
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
      })
    ).rejects.toThrow('Resume inputs are invalid JSON');
  });

  it('fails closed when resume inputs metadata is missing', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const fetchMock = vi.fn(async () => {
      throw new Error('resume should fail before task execution');
    });
    vi.stubGlobal('fetch', fetchMock);

    const definition: BuiltInFlowDefinition = {
      id: 'flow.setup-readiness-10m',
      title: 'Missing resume inputs',
      intent: 'reject missing stored inputs',
      writeCapable: true,
      recipeCommands: [],
      steps: [
        {
          kind: 'gate',
          id: 'gate_1',
          title: 'Approval',
          command: 'Human gate',
          mutating: false,
          detail: 'approve resume'
        },
        {
          kind: 'task',
          id: 'inspect_fleet',
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
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-missing-resume-inputs`);

    const first = await runDeterministicFlow({
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
    rmSync(first.inputsPath);

    await expect(
      runDeterministicFlow({
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
      })
    ).rejects.toThrow('Resume inputs metadata is missing');
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('fails closed when persisted inspect scope payload is malformed', async () => {
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

    await expect(
      runDeterministicFlow({
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
      })
    ).rejects.toThrow('Resume inputs are invalid JSON');
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
    runSpaceImportTreeOverride = async () =>
      UtilityBatchResultSchema.parse({
        schemaVersion: 'xyte.utility.batch.v1',
        generatedAtUtc: new Date().toISOString(),
        tenantId: 'acme',
        command: 'space.import-tree',
        mode: 'dry-run',
        totals: { rows: 1, planned: 1, succeeded: 0, failed: 0, skipped: 0 },
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

  it('pauses edge-claim-batch after prepare so the scaffold can be filled before dry-run', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-claim-batch`);
    const sourcePath = join(tmpdir(), `edge-claim-source-${Date.now()}.csv`);
    writeFileSync(sourcePath, 'source\nplaceholder\n');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models?')) {
        return new Response(JSON.stringify({ items: [{ id: 'model-1', model: 'Sensor' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [{ name: 'Port', type: 'number' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge-claim-batch prepare test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const plan = await runDeterministicFlow({
      flowId: 'flow.edge-claim-batch',
      tenantId: 'acme',
      mode: 'plan',
      outDir,
      context: {
        device_model_id: 'model-1',
        edge_claim_input_path: sourcePath
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(plan.outcome).toBe('pending_gate');
    expect(plan.cursor.nextStepId).toBe('gate_edge_claim_prepare_review');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(plan.steps.find((item) => item.stepId === 'edge_claim_batch_models_list')?.status).toBe('completed');
    expect(plan.steps.find((item) => item.stepId === 'edge_claim_batch_model_describe')?.status).toBe('completed');
    expect(plan.steps.find((item) => item.stepId === 'edge_claim_prepare')?.status).toBe('completed');
    expect(plan.steps.find((item) => item.stepId === 'edge_claim_dry_run')?.status).toBe('pending');
    const plannedInputs = JSON.parse(readFileSync(plan.inputsPath, 'utf8'));
    expect(plannedInputs.context.edge_claim_prepare_csv).toContain('organization-edge-startclaim.csv');
    expect(plan.nextAction?.artifactPaths.some((item) => item.endsWith('organization-edge-startclaim.csv'))).toBe(true);
    expect(
      plan.nextAction?.artifactPaths.some((item) => item.endsWith('organization-edge-startclaim.rejected.csv'))
    ).toBe(true);
    expect(plan.nextAction?.artifactPaths.some((item) => item.endsWith('organization-edge-startclaim.notes.md'))).toBe(
      true
    );
  });

  it('pauses a fresh edge-claim-batch apply run at prepare review before the dry-run executes', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-claim-batch-apply`);
    const sourcePath = join(tmpdir(), `edge-claim-source-${Date.now()}-apply.csv`);
    writeFileSync(sourcePath, 'source\nplaceholder\n');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models?')) {
        return new Response(JSON.stringify({ items: [{ id: 'model-1', model: 'Sensor' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [{ name: 'Port', type: 'number' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge-claim-batch fresh apply test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const apply = await runDeterministicFlow({
      flowId: 'flow.edge-claim-batch',
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_model_id: 'model-1',
        edge_claim_input_path: sourcePath
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(apply.outcome).toBe('pending_gate');
    expect(apply.cursor.nextStepId).toBe('gate_edge_claim_prepare_review');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(apply.steps.find((item) => item.stepId === 'edge_claim_batch_models_list')?.status).toBe('completed');
    expect(apply.steps.find((item) => item.stepId === 'edge_claim_batch_model_describe')?.status).toBe('completed');
    expect(apply.steps.find((item) => item.stepId === 'edge_claim_prepare')?.status).toBe('completed');
    expect(apply.steps.find((item) => item.stepId === 'gate_edge_claim_prepare_review')?.status).toBe('gate_pending');
    expect(apply.steps.find((item) => item.stepId === 'edge_claim_dry_run')?.status).toBe('pending');
  });

  it('approves the prepare review gate on resumed edge-claim-batch apply runs', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-claim-batch-resume`);
    const sourcePath = join(tmpdir(), `edge-claim-source-${Date.now()}-resume.csv`);
    writeFileSync(sourcePath, 'source\nplaceholder\n');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models?')) {
        return new Response(JSON.stringify({ items: [{ id: 'model-1', model: 'Sensor' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [{ name: 'Port', type: 'number' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge-claim-batch resume test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const firstApply = await runDeterministicFlow({
      flowId: 'flow.edge-claim-batch',
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_model_id: 'model-1',
        edge_claim_input_path: sourcePath
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    const resumedApply = await runDeterministicFlow({
      flowId: 'flow.edge-claim-batch',
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: firstApply.runId,
      context: {
        device_model_id: 'model-1',
        edge_claim_input_path: sourcePath
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(resumedApply.outcome).toBe('pending_gate');
    expect(resumedApply.cursor.nextStepId).toBe('gate_edge_claim_batch_apply');
    expect(resumedApply.steps.find((item) => item.stepId === 'gate_edge_claim_prepare_review')?.status).toBe(
      'gate_approved'
    );
    expect(resumedApply.steps.find((item) => item.stepId === 'edge_claim_dry_run')?.status).toBe('completed');
  });

  it('runs populated edge-claim-batch through dry-run and apply gates', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-claim-batch-complete`);
    const sourcePath = join(tmpdir(), `edge-claim-source-${Date.now()}-complete.csv`);
    writeFileSync(sourcePath, 'source\nplaceholder\n');
    const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({
        url,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
      });
      if (url.includes('/core/v1/organization/models?')) {
        return new Response(JSON.stringify({ items: [{ id: 'model-1', model: 'Sensor' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [{ name: 'Port', type: 'number' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/core/v1/organization/edges/devices/start_ping')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/core/v1/organization/edges/devices/get_ping_status')) {
        return new Response(JSON.stringify({ status: 'success' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/core/v1/organization/edges/devices/start_claim')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/core/v1/organization/edges/devices/get_claim_status')) {
        return new Response(JSON.stringify({ result: 'success' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge-claim-batch flow test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const firstApply = await runDeterministicFlow({
      flowId: 'flow.edge-claim-batch',
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_model_id: 'model-1',
        edge_claim_input_path: sourcePath
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });
    const preparedInputs = JSON.parse(readFileSync(firstApply.inputsPath, 'utf8')) as {
      context: Record<string, string>;
    };
    writeFileSync(
      preparedInputs.context.edge_claim_prepare_csv,
      [
        'proxy_id,device_ip,device_model_id,space_id,skip_connectivity_check',
        'proxy-1,192.168.1.10,model-1,99,true',
        'proxy-1,192.168.1.11,model-1,99,false',
        'proxy-1,192.168.1.12,model-1,99,'
      ].join('\n'),
      'utf8'
    );

    const dryRunApproved = await runDeterministicFlow({
      flowId: 'flow.edge-claim-batch',
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: firstApply.runId,
      context: {
        device_model_id: 'model-1',
        edge_claim_input_path: sourcePath
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });
    expect(dryRunApproved.outcome).toBe('pending_gate');
    expect(dryRunApproved.cursor.nextStepId).toBe('gate_edge_claim_batch_apply');

    const completed = await runDeterministicFlow({
      flowId: 'flow.edge-claim-batch',
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: dryRunApproved.runId,
      context: {
        device_model_id: 'model-1',
        edge_claim_input_path: sourcePath
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(completed.outcome).toBe('completed');
    expect(completed.steps.find((item) => item.stepId === 'edge_claim_apply')?.status).toBe('completed');
    const completedInputs = JSON.parse(readFileSync(completed.inputsPath, 'utf8')) as {
      context: Record<string, string>;
    };
    expect(existsSync(completedInputs.context.edge_claim_apply_report_path)).toBe(true);
    expect(existsSync(join(completed.bundleDir, 'outputs', 'edge-claim.resume.ndjson'))).toBe(true);
    expect(requests.filter((request) => request.url.includes('/start_ping'))).toHaveLength(2);
    const claimBodies = requests
      .filter((request) => request.url.includes('/start_claim'))
      .map((request) => request.body);
    expect(claimBodies).toHaveLength(3);
    expect(claimBodies[0]?.skip_connectivity_check).toBe(true);
    expect(claimBodies[1]?.skip_connectivity_check).toBe(false);
    expect(claimBodies[2]).not.toHaveProperty('skip_connectivity_check');
  });

  it('fails flow.edge-claim-batch apply with ping-failed detail', async () => {
    const { profileStore, secretStore, client } = await makeClient();
    const outDir = join(tmpdir(), `xyte-flow-runner-${Date.now()}-edge-claim-batch-ping-failed`);
    const sourcePath = join(tmpdir(), `edge-claim-source-${Date.now()}-ping-failed.csv`);
    writeFileSync(sourcePath, 'source\nplaceholder\n');

    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/core/v1/organization/models?')) {
        return new Response(JSON.stringify({ items: [{ id: 'model-1', model: 'Sensor' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/core/v1/organization/models/model-1')) {
        return new Response(JSON.stringify({ id: 'model-1', parameters: [{ name: 'Port', type: 'number' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      if (url.includes('/core/v1/organization/edges/devices/start_ping')) {
        return new Response(null, { status: 204 });
      }
      if (url.includes('/core/v1/organization/edges/devices/get_ping_status')) {
        return new Response(JSON.stringify({ status: 'failed' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        });
      }
      throw new Error(`Unexpected URL in edge-claim-batch ping-failed flow test: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const firstApply = await runDeterministicFlow({
      flowId: 'flow.edge-claim-batch',
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      context: {
        device_model_id: 'model-1',
        edge_claim_input_path: sourcePath
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });
    const preparedInputs = JSON.parse(readFileSync(firstApply.inputsPath, 'utf8')) as {
      context: Record<string, string>;
    };
    writeFileSync(
      preparedInputs.context.edge_claim_prepare_csv,
      'proxy_id,device_ip,device_model_id,space_id,skip_connectivity_check\nproxy-1,192.168.1.10,model-1,99,\n',
      'utf8'
    );

    const dryRunApproved = await runDeterministicFlow({
      flowId: 'flow.edge-claim-batch',
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: firstApply.runId,
      context: {
        device_model_id: 'model-1',
        edge_claim_input_path: sourcePath
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    const failed = await runDeterministicFlow({
      flowId: 'flow.edge-claim-batch',
      tenantId: 'acme',
      mode: 'apply',
      outDir,
      resume: dryRunApproved.runId,
      context: {
        device_model_id: 'model-1',
        edge_claim_input_path: sourcePath
      },
      once: true,
      strictJson: true,
      profileStore,
      secretStore,
      client
    });

    expect(failed.outcome).toBe('failed');
    const failedStep = failed.steps.find((item) => item.stepId === 'edge_claim_apply');
    expect(failedStep?.status).toBe('failed');
    expect(String(failedStep?.error?.detail ?? '')).toContain('1 ping-failed');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/start_claim'))).toBe(false);
  });
});
