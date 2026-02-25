import { describe, expect, it } from 'vitest';

const scriptPath = '../scripts/smoke_flow_pack_local.mjs';

describe('local flow-pack smoke classifier', () => {
  it('treats expected write-guard rejection as pass', async () => {
    const mod = await import(scriptPath);
    const classified = mod.classifyStep('send_command_guard_missing_allowwrite', {
      code: 1,
      stdout: '',
      stderr: 'Endpoint organization.commands.sendCommand is a write operation (POST). Re-run with --allow-write.'
    });
    expect(classified.status).toBe('pass');
  });

  it('treats known data-gated sendCommand 422 as pass', async () => {
    const mod = await import(scriptPath);
    const classified = mod.classifyStep('send_command_write', {
      code: 1,
      stdout: JSON.stringify({
        error: {
          status: 422,
          upstream: { error: 'Either a valid command or friendly_name is required' }
        }
      }),
      stderr: ''
    });
    expect(classified.status).toBe('pass');
  });

  it('fails update-device verify when read-back did not match expected values', async () => {
    const mod = await import(scriptPath);
    const classified = mod.classifyStep(
      'update_device_verify',
      {
        code: 1,
        stdout: '{}',
        stderr: 'Update read-back did not match expected value.'
      },
      { updateVerified: false }
    );
    expect(classified.status).toBe('fail');
  });

  it('passes update-device verify when read-back succeeds but fields are unchanged', async () => {
    const mod = await import(scriptPath);
    const classified = mod.classifyStep(
      'update_device_verify',
      {
        code: 1,
        stdout: '{}',
        stderr: 'Update read-back did not match expected value.'
      },
      { updateVerified: false, readBackSucceeded: true }
    );
    expect(classified.status).toBe('pass');
  });
});
