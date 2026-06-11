import { describe, expect, it, vi } from 'vitest';

import { createOrganizationNamespace } from '../src/client/namespaces/organization';
import { createPartnerNamespace } from '../src/client/namespaces/partner';

describe('namespace endpoint mappings', () => {
  it('maps partner.getDevices to partner.devices.getDevices', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const partner = createPartnerNamespace(call);

    await partner.getDevices({ query: { page: 1 } });

    expect(call).toHaveBeenCalledWith('partner.devices.getDevices', {
      query: { page: 1 }
    });
  });

  it('maps organization.closeIncident to organization.incidents.closeIncident', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const organization = createOrganizationNamespace(call);

    await organization.closeIncident({ path: { incident_id: 'inc-1' } });

    expect(call).toHaveBeenCalledWith('organization.incidents.closeIncident', {
      path: { incident_id: 'inc-1' }
    });
  });

  it('maps organization.updateDevice to organization.devices.updateDevice', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const organization = createOrganizationNamespace(call);

    await organization.updateDevice({ path: { device_id: 'dev-1' }, body: { nickname: 'Lab Unit' } });

    expect(call).toHaveBeenCalledWith('organization.devices.updateDevice', {
      path: { device_id: 'dev-1' },
      body: { nickname: 'Lab Unit' }
    });
  });

  it('maps organization.moveDevice to organization.devices.moveDevice', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const organization = createOrganizationNamespace(call);

    await organization.moveDevice({ path: { device_id: 'dev-1' }, body: { space_id: 99592 } });

    expect(call).toHaveBeenCalledWith('organization.devices.moveDevice', {
      path: { device_id: 'dev-1' },
      body: { space_id: 99592 }
    });
  });

  it('maps new organization device incident controls', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const organization = createOrganizationNamespace(call);

    await organization.suspendIncidents({ path: { device_id: 'dev-1' } });
    await organization.resumeIncidents({ path: { device_id: 'dev-1' } });

    expect(call).toHaveBeenNthCalledWith(1, 'organization.devices.suspendIncidents', {
      path: { device_id: 'dev-1' }
    });
    expect(call).toHaveBeenNthCalledWith(2, 'organization.devices.resumeIncidents', {
      path: { device_id: 'dev-1' }
    });
  });

  it('maps organization.startEdgeClaim to organization.edge.startClaim', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const organization = createOrganizationNamespace(call);

    await organization.startEdgeClaim({
      body: {
        proxy_id: 'proxy-1',
        device_ip: '192.168.1.100',
        device_model_id: 'model-1',
        space_id: 10000
      }
    });

    expect(call).toHaveBeenCalledWith('organization.edge.startClaim', {
      body: {
        proxy_id: 'proxy-1',
        device_ip: '192.168.1.100',
        device_model_id: 'model-1',
        space_id: 10000
      }
    });
  });

  it('maps organization.getEdgeClaimStatus to organization.edge.getClaimStatus', async () => {
    const call = vi.fn().mockResolvedValue({ result: 'pending' });
    const organization = createOrganizationNamespace(call);

    await organization.getEdgeClaimStatus({
      query: { proxy_id: 'proxy-1', device_ip: '192.168.1.100' }
    });

    expect(call).toHaveBeenCalledWith('organization.edge.getClaimStatus', {
      query: { proxy_id: 'proxy-1', device_ip: '192.168.1.100' }
    });
  });

  it('maps organization.startEdgePing to organization.edge.startPing', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const organization = createOrganizationNamespace(call);

    await organization.startEdgePing({
      body: { proxy_id: 'proxy-1', device_ip: '192.168.1.100' }
    });

    expect(call).toHaveBeenCalledWith('organization.edge.startPing', {
      body: { proxy_id: 'proxy-1', device_ip: '192.168.1.100' }
    });
  });

  it('maps organization.getEdgePingStatus to organization.edge.getPingStatus', async () => {
    const call = vi.fn().mockResolvedValue({ status: 'pending' });
    const organization = createOrganizationNamespace(call);

    await organization.getEdgePingStatus({
      query: { proxy_id: 'proxy-1', device_ip: '192.168.1.100' }
    });

    expect(call).toHaveBeenCalledWith('organization.edge.getPingStatus', {
      query: { proxy_id: 'proxy-1', device_ip: '192.168.1.100' }
    });
  });

  it('maps organization.updateEdgeHostname to organization.edge.updateHostname', async () => {
    const call = vi.fn().mockResolvedValue({ success: true });
    const organization = createOrganizationNamespace(call);

    await organization.updateEdgeHostname({
      path: { device_id: 'dev-1' },
      body: { device_ip: '192.168.1.100', skip_connectivity_check: false }
    });

    expect(call).toHaveBeenCalledWith('organization.edge.updateHostname', {
      path: { device_id: 'dev-1' },
      body: { device_ip: '192.168.1.100', skip_connectivity_check: false }
    });
  });

  it('maps organization.getEdges to organization.edges.getEdges', async () => {
    const call = vi.fn().mockResolvedValue({ items: [] });
    const organization = createOrganizationNamespace(call);

    await organization.getEdges({ query: { page: 1, per_page: 50 } });

    expect(call).toHaveBeenCalledWith('organization.edges.getEdges', {
      query: { page: 1, per_page: 50 }
    });
  });

  it('maps organization users and groups to their endpoint keys', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const organization = createOrganizationNamespace(call);

    await organization.getUsers({ query: { page: 1 } });
    await organization.createUser({ body: { email: 'jane@example.com', name: 'Jane Doe' } });
    await organization.getUser({ path: { id: 'user-1' } });
    await organization.deactivateUser({ path: { id: 'user-1' } });
    await organization.resendWelcome({ path: { id: 'user-1' } });
    await organization.getGroups({ query: { page: 1 } });
    await organization.createGroup({ body: { name: 'Support' } });
    await organization.getGroup({ path: { id: 'group-1' } });
    await organization.updateGroup({ path: { id: 'group-1' }, body: { name: 'Field Support' } });
    await organization.addUsers({ path: { id: 'group-1' }, body: { user_ids: ['user-1'] } });
    await organization.addExternalUser({
      path: { id: 'group-1' },
      body: { email: 'partner@example.com' }
    });
    await organization.removeUsers({ path: { id: 'group-1' }, body: { user_ids: ['user-1'] } });
    await organization.deleteGroup({ path: { id: 'group-1' } });

    expect(call).toHaveBeenNthCalledWith(1, 'organization.users.getUsers', { query: { page: 1 } });
    expect(call).toHaveBeenNthCalledWith(2, 'organization.users.createUser', {
      body: { email: 'jane@example.com', name: 'Jane Doe' }
    });
    expect(call).toHaveBeenNthCalledWith(3, 'organization.users.getUser', { path: { id: 'user-1' } });
    expect(call).toHaveBeenNthCalledWith(4, 'organization.users.deactivateUser', { path: { id: 'user-1' } });
    expect(call).toHaveBeenNthCalledWith(5, 'organization.users.resendWelcome', { path: { id: 'user-1' } });
    expect(call).toHaveBeenNthCalledWith(6, 'organization.groups.getGroups', { query: { page: 1 } });
    expect(call).toHaveBeenNthCalledWith(7, 'organization.groups.createGroup', { body: { name: 'Support' } });
    expect(call).toHaveBeenNthCalledWith(8, 'organization.groups.getGroup', { path: { id: 'group-1' } });
    expect(call).toHaveBeenNthCalledWith(9, 'organization.groups.updateGroup', {
      path: { id: 'group-1' },
      body: { name: 'Field Support' }
    });
    expect(call).toHaveBeenNthCalledWith(10, 'organization.groups.addUsers', {
      path: { id: 'group-1' },
      body: { user_ids: ['user-1'] }
    });
    expect(call).toHaveBeenNthCalledWith(11, 'organization.groups.addExternalUser', {
      path: { id: 'group-1' },
      body: { email: 'partner@example.com' }
    });
    expect(call).toHaveBeenNthCalledWith(12, 'organization.groups.removeUsers', {
      path: { id: 'group-1' },
      body: { user_ids: ['user-1'] }
    });
    expect(call).toHaveBeenNthCalledWith(13, 'organization.groups.deleteGroup', { path: { id: 'group-1' } });
  });

  it('maps partner.createOrganization to partner.organizations.createOrganization', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const partner = createPartnerNamespace(call);

    await partner.createOrganization({ body: { name: 'Acme HQ' } });

    expect(call).toHaveBeenCalledWith('partner.organizations.createOrganization', {
      body: { name: 'Acme HQ' }
    });
  });
});
