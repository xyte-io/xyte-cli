import { describe, expect, it } from 'vitest';
import Ajv2020 from 'ajv/dist/2020';

import callEnvelopeSchema from '../docs/schemas/call-envelope.v1.schema.json';
import deepDiveSchema from '../docs/schemas/inspect-deep-dive.v1.schema.json';
import fleetSchema from '../docs/schemas/inspect-fleet.v1.schema.json';
import headlessSchema from '../docs/schemas/headless-frame.v1.schema.json';
import reportSchema from '../docs/schemas/report.v1.schema.json';
import { buildCallEnvelope } from '../src/contracts/call-envelope';
import { buildDeepDive, buildFleetInspect, generateFleetReport } from '../src/workflows/fleet-insights';
import { runHeadlessRenderer } from '../src/tui/headless-renderer';
import { MemoryKeychain } from '../src/secure/keychain';
import { MemoryProfileStore } from './support/memory-profile-store';

const ajv = new Ajv2020({ strict: false });
const validateCallEnvelope = ajv.compile(callEnvelopeSchema);
const validateHeadless = ajv.compile(headlessSchema);
const validateFleet = ajv.compile(fleetSchema);
const validateDeepDive = ajv.compile(deepDiveSchema);
const validateReport = ajv.compile(reportSchema);

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
      incidents: [{ id: 'i1', device_name: 'Device 1', status: 'active', space_tree_path_name: 'Overview/A', created_at: new Date().toISOString() }],
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

  it('validates headless runtime frame payload', async () => {
    const profileStore = new MemoryProfileStore();
    const keychain = new MemoryKeychain();
    await profileStore.upsertTenant({ id: 'acme' });
    await profileStore.setActiveTenant('acme');
    const slot = await profileStore.addKeySlot('acme', {
      provider: 'xyte-org',
      name: 'primary',
      fingerprint: 'sha256:test'
    });
    await keychain.setSlotSecret('acme', 'xyte-org', slot.slotId, 'org-key');

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
      keychain,
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
});
