import { describe, expect, it, vi } from 'vitest';

import { sendCommandWithGuard } from '../../src/tui/screens/devices';
import { makeTuiContext, makeXyteClientMock } from '../support/typed-mocks';

describe('devices screen actions', () => {
  it('sends command payload using command template', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ ok: true });
    const context = makeTuiContext({
      client: makeXyteClientMock({ organization: { sendCommand } }),
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    });

    const result = await sendCommandWithGuard({
      device: { id: 'dev-1' },
      template: { mode: 'command', value: 'reboot', label: 'command: reboot' },
      params: { wait_ms: 5000 },
      context
    });

    expect(result).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith({
      tenantId: 'acme',
      path: { device_id: 'dev-1' },
      body: {
        command: 'reboot',
        params: { wait_ms: 5000 }
      }
    });
  });

  it('sends command payload using friendly_name template', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ ok: true });
    const context = makeTuiContext({
      client: makeXyteClientMock({ organization: { sendCommand } }),
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    });

    const result = await sendCommandWithGuard({
      device: { id: 'dev-1' },
      template: { mode: 'friendly_name', value: 'reboot', label: 'friendly_name: reboot' },
      params: undefined,
      context
    });

    expect(result).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith({
      tenantId: 'acme',
      path: { device_id: 'dev-1' },
      body: {
        friendly_name: 'reboot'
      }
    });
  });

  it('fails when device id is missing', async () => {
    const sendCommand = vi.fn();
    const context = makeTuiContext({
      client: makeXyteClientMock({ organization: { sendCommand } }),
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    });

    const result = await sendCommandWithGuard({
      device: {},
      template: { mode: 'command', value: 'reboot', label: 'command: reboot' },
      params: undefined,
      context
    });

    expect(result).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
