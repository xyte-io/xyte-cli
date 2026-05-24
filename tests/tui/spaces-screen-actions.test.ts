import { describe, expect, it, vi } from 'vitest';

import { claimDeviceWithGuard, createChildSpaceWithGuard, renameSpaceWithGuard } from '../../src/tui/screens/spaces';
import { makeTuiContext, makeXyteClientMock } from '../support/typed-mocks';

describe('spaces screen actions', () => {
  it('claims device with guided fields and confirmation', async () => {
    const claimDevice = vi.fn().mockResolvedValue({ ok: true });
    const context = makeTuiContext({
      client: makeXyteClientMock({ organization: { claimDevice } }),
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    });

    const result = await claimDeviceWithGuard({
      spaceId: 'space-1',
      name: 'Projector A',
      sn: 'SN-1',
      context
    });

    expect(result).toBe(true);
    expect(claimDevice).toHaveBeenCalledWith({
      tenantId: 'acme',
      body: {
        name: 'Projector A',
        space_id: 'space-1',
        sn: 'SN-1'
      }
    });
  });

  it('rejects claim when identifiers are missing', async () => {
    const claimDevice = vi.fn();
    const context = makeTuiContext({
      client: makeXyteClientMock({ organization: { claimDevice } }),
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    });

    const result = await claimDeviceWithGuard({
      spaceId: 'space-1',
      name: 'Projector A',
      context
    });

    expect(result).toBe(false);
    expect(claimDevice).not.toHaveBeenCalled();
  });

  it('creates child space after confirmation', async () => {
    const createSpace = vi.fn().mockResolvedValue({ ok: true });
    const context = makeTuiContext({
      client: makeXyteClientMock({ organization: { createSpace } }),
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    });

    const result = await createChildSpaceWithGuard({
      parentSpaceId: 'space-1',
      name: 'Child',
      spaceType: 'office',
      config: { priority_factor: '1' },
      context
    });

    expect(result).toBe(true);
    expect(createSpace).toHaveBeenCalledWith({
      tenantId: 'acme',
      body: {
        name: 'Child',
        parent_id: 'space-1',
        space_type: 'office',
        config: { priority_factor: '1' }
      }
    });
  });

  it('renames selected space after confirmation', async () => {
    const updateSpace = vi.fn().mockResolvedValue({ ok: true });
    const context = makeTuiContext({
      client: makeXyteClientMock({ organization: { updateSpace } }),
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    });

    const result = await renameSpaceWithGuard({
      spaceId: 'space-1',
      name: 'Renamed',
      context
    });

    expect(result).toBe(true);
    expect(updateSpace).toHaveBeenCalledWith({
      tenantId: 'acme',
      path: { space_id: 'space-1' },
      body: { name: 'Renamed' }
    });
  });
});
