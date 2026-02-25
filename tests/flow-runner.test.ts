import { readFileSync } from 'node:fs';
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
});
