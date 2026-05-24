import { describe, expect, it, vi } from 'vitest';

import { closeIncidentWithGuard } from '../../src/tui/screens/incidents';

describe('incidents screen actions', () => {
  it('closes incident after token confirmation', async () => {
    const closeIncident = vi.fn().mockResolvedValue({ ok: true });
    const context = {
      client: {
        organization: { closeIncident }
      },
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    } as unknown as Parameters<typeof closeIncidentWithGuard>[0]['context'];

    const result = await closeIncidentWithGuard({
      incident: { id: 'inc-1' },
      context
    });

    expect(result).toBe(true);
    expect(context.confirmWrite).toHaveBeenCalledWith('Close incident', 'close');
    expect(closeIncident).toHaveBeenCalledWith({
      tenantId: 'acme',
      path: { incident_id: 'inc-1' }
    });
  });

  it('does not close when id is missing', async () => {
    const closeIncident = vi.fn();
    const context = {
      client: {
        organization: { closeIncident }
      },
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    } as unknown as Parameters<typeof closeIncidentWithGuard>[0]['context'];

    const result = await closeIncidentWithGuard({
      incident: {},
      context
    });

    expect(result).toBe(false);
    expect(closeIncident).not.toHaveBeenCalled();
  });
});
