import { describe, expect, it, vi } from 'vitest';

import { createDeviceNamespace } from '../src/namespaces/device';
import { createOrganizationNamespace } from '../src/namespaces/organization';

describe('namespace endpoint mappings', () => {
  it('maps device.spaceMove to device.device-info.spaceMove', async () => {
    const call = vi.fn().mockResolvedValue({ ok: true });
    const device = createDeviceNamespace(call);

    await device.spaceMove({ path: { device_id: 'dev-1', space_id: 'sp-1' } });

    expect(call).toHaveBeenCalledWith('device.device-info.spaceMove', {
      path: { device_id: 'dev-1', space_id: 'sp-1' }
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
});
