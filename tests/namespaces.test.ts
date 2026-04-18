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
});
