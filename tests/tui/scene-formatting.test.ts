import { describe, expect, it } from 'vitest';

import {
  sceneFromConfigState,
  sceneFromDevicesState,
  sceneFromIncidentsState,
  sceneFromSetupState,
  sceneFromSpacesState,
  sceneFromTicketsState
} from '../../src/tui/scene';

describe('scene compact formatting', () => {
  it('emits compact device/ticket/incident/space table rows', () => {
    const longId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const longName = 'Very long name that should be truncated for compact table readability in the terminal';

    const devices = sceneFromDevicesState({
      searchText: '',
      selectedIndex: 0,
      devices: [{ id: longId, name: longName, status: 'online', space_name: 'Main Office Floor West Wing Area 7' }]
    });
    const incidents = sceneFromIncidentsState({
      selectedIndex: 0,
      severityFilter: '',
      incidents: [{ id: longId, severity: 'critical', status: 'open', device_id: longId }]
    });
    const tickets = sceneFromTicketsState({
      mode: 'organization',
      searchText: '',
      selectedIndex: 0,
      tickets: [{ id: longId, status: 'open', priority: 'p1', subject: longName }]
    });
    const spaces = sceneFromSpacesState({
      selectedIndex: 0,
      searchText: '',
      loading: false,
      paneStatus: 'ok',
      spaces: [{ id: longId, name: longName, type: 'building', path: 'Very/Long/Path/That/Needs/Truncation/Here' }],
      devicesInSpace: []
    });

    const deviceIdCell = devices.find((p) => p.id === 'devices-table')?.table?.rows[0]?.[0] as string;
    const incidentIdCell = incidents.find((p) => p.id === 'incidents-table')?.table?.rows[0]?.[0] as string;
    const ticketSubjectCell = tickets.find((p) => p.id === 'tickets-table')?.table?.rows[0]?.[3] as string;
    const spacePathCell = spaces.find((p) => p.id === 'spaces-list')?.table?.rows[0]?.[3] as string;

    expect(deviceIdCell).toContain('…');
    expect(incidentIdCell).toContain('…');
    expect(ticketSubjectCell).toContain('…');
    expect(spacePathCell).toContain('…');
  });

  it('reduces config slot table columns and keeps metadata in action panel', () => {
    const panels = sceneFromConfigState({
      tenantId: 'tenant-1',
      providerRows: [
        {
          provider: 'xyte-org',
          slotCount: 1,
          activeSlot: 'primary-slot-id',
          hasSecret: 'yes',
          lastValidatedAt: '2026-02-08T10:00:00.000Z'
        }
      ],
      selectedProvider: 'xyte-org',
      slotRows: [
        {
          provider: 'xyte-org',
          slotId: 'primary-slot-id',
          name: 'primary',
          active: 'yes',
          hasSecret: 'yes',
          fingerprint: 'sha256:abc123'
        }
      ],
      selectedSlot: {
        provider: 'xyte-org',
        slotId: 'primary-slot-id',
        name: 'primary',
        active: 'yes',
        hasSecret: 'yes',
        fingerprint: 'sha256:abc123'
      },
      doctorStatus: 'connected'
    });

    const slotPanel = panels.find((panel) => panel.id === 'config-slots');
    const actionPanel = panels.find((panel) => panel.id === 'config-actions');
    expect(slotPanel?.table?.columns).toEqual(['Provider', 'Slot', 'Active', 'Secret']);
    expect((actionPanel?.text?.lines ?? []).join('\n')).toContain('Fingerprint: sha256:abc123');
  });

  it('shortens setup active slot in provider table', () => {
    const panels = sceneFromSetupState({
      readinessState: 'needs_setup',
      connectionState: 'missing_key',
      missingItems: ['missing key'],
      recommendedActions: ['add key'],
      providerRows: [
        {
          provider: 'xyte-org',
          slotCount: 1,
          activeSlot: 'very-long-slot-id-for-primary-tenant-slot',
          hasSecret: 'yes'
        }
      ]
    });
    const slotCell = panels.find((panel) => panel.id === 'setup-providers')?.table?.rows[0]?.[2] as string;
    expect(slotCell).toContain('…');
  });
});
