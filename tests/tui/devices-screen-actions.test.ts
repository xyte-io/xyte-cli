import { describe, expect, it, vi } from 'vitest';

import type { CommandTemplate } from '../../src/tui/data-loaders';
import { sendCommandWithGuard } from '../../src/tui/screens/devices';

function commandTemplate(
  mode: CommandTemplate['mode'],
  value: string,
  commands: unknown[],
  withFile = false
): CommandTemplate {
  return {
    mode,
    value,
    label: `${mode}: ${value}`,
    withFile,
    modelEvidence: {
      modelId: 'model-1',
      modelData: { commands }
    }
  };
}

describe('devices screen actions', () => {
  it('sends command payload using command template', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ ok: true });
    const context: any = {
      client: {
        organization: { sendCommand }
      },
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    };

    const result = await sendCommandWithGuard({
      device: { id: 'dev-1' },
      template: commandTemplate('command', 'reboot', [{ name: 'reboot', custom_fields: [{ name: 'wait_ms' }] }]),
      params: { wait_ms: 5000 },
      context
    });

    expect(result).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith({
      tenantId: 'acme',
      path: { device_id: 'dev-1' },
      body: {
        command: 'reboot',
        extra_params: { wait_ms: 5000 }
      }
    });
  });

  it('sends command payload using friendly_name template', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ ok: true });
    const context: any = {
      client: {
        organization: { sendCommand }
      },
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    };

    const result = await sendCommandWithGuard({
      device: { id: 'dev-1' },
      template: commandTemplate('friendly_name', 'Restart device', [
        { name: 'reboot', friendly_name: 'Restart device' }
      ]),
      params: undefined,
      context
    });

    expect(result).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith({
      tenantId: 'acme',
      path: { device_id: 'dev-1' },
      body: {
        friendly_name: 'Restart device'
      }
    });
  });

  it('maps a model option label to its canonical value before sending', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ ok: true });
    const context: any = {
      client: {
        organization: { sendCommand }
      },
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    };

    const result = await sendCommandWithGuard({
      device: { id: 'dev-1' },
      template: commandTemplate('command', 'set_input', [
        {
          name: 'set_input',
          custom_fields: [
            {
              name: 'input',
              type: 'select',
              required: true,
              options: { source_a: { label: 'Source A', value: 'source_a' } }
            }
          ]
        }
      ]),
      params: { input: 'Source A' },
      context
    });

    expect(result).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith({
      tenantId: 'acme',
      path: { device_id: 'dev-1' },
      body: {
        command: 'set_input',
        extra_params: { input: 'source_a' }
      }
    });
  });

  it('sends a trimmed file id for a command that requires a file', async () => {
    const sendCommand = vi.fn().mockResolvedValue({ ok: true });
    const context: any = {
      client: {
        organization: { sendCommand }
      },
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    };

    const result = await sendCommandWithGuard({
      device: { id: 'dev-1' },
      template: commandTemplate('command', 'upload', [{ name: 'upload', with_file: true }], true),
      params: undefined,
      fileId: '  file-7  ',
      context
    });

    expect(result).toBe(true);
    expect(sendCommand).toHaveBeenCalledWith({
      tenantId: 'acme',
      path: { device_id: 'dev-1' },
      body: { command: 'upload', file_id: 'file-7' }
    });
  });

  it.each([
    {
      label: 'a required parameter is missing',
      commands: [{ name: 'identify', custom_fields: [{ name: 'delay', required: true }] }],
      params: undefined,
      expectedError: 'requires extra_params field(s): delay'
    },
    {
      label: 'an unknown parameter is supplied',
      commands: [{ name: 'identify', custom_fields: [{ name: 'delay' }] }],
      params: { unexpected: true },
      expectedError: 'does not define extra_params field(s): unexpected'
    },
    {
      label: 'the selected command name is ambiguous',
      commands: [{ name: 'identify' }, { name: 'identify' }],
      params: undefined,
      expectedError: 'command name "identify" is ambiguous'
    },
    {
      label: 'the selected command requires a file',
      commands: [{ name: 'identify', with_file: true }],
      params: undefined,
      withFile: true,
      expectedError: 'requires command_file_id'
    },
    {
      label: 'an omitted optional field has malformed choices',
      commands: [
        {
          name: 'identify',
          custom_fields: [{ name: 'mode', type: 'select', required: false, options: 'invalid' }]
        }
      ],
      params: undefined,
      expectedError: 'invalid or ambiguous options metadata'
    },
    {
      label: 'an omitted optional field has path-backed choices',
      commands: [
        {
          name: 'identify',
          custom_fields: [{ name: 'mode', typeName: 'dynamicListSingle', required: false, path: 'details.modes' }]
        }
      ],
      params: undefined,
      expectedError: 'uses path-backed options'
    }
  ])('blocks sending when $label', async ({ commands, params, withFile = false, expectedError }) => {
    const sendCommand = vi.fn();
    const context: any = {
      client: {
        organization: { sendCommand }
      },
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    };

    const result = await sendCommandWithGuard({
      device: { id: 'dev-1' },
      template: commandTemplate('command', 'identify', commands, withFile),
      params,
      context
    });

    expect(result).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
    expect(context.confirmWrite).not.toHaveBeenCalled();
    expect(context.showError).toHaveBeenCalledTimes(1);
    expect(String(context.showError.mock.calls[0]?.[0]?.message ?? '')).toContain(expectedError);
  });

  it('fails when device id is missing', async () => {
    const sendCommand = vi.fn();
    const context: any = {
      client: {
        organization: { sendCommand }
      },
      getActiveTenantId: vi.fn().mockResolvedValue('acme'),
      confirmWrite: vi.fn().mockResolvedValue(true),
      setStatus: vi.fn(),
      showError: vi.fn()
    };

    const result = await sendCommandWithGuard({
      device: {},
      template: commandTemplate('command', 'reboot', [{ name: 'reboot' }]),
      params: undefined,
      context
    });

    expect(result).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});
