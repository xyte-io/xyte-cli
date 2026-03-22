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
});
