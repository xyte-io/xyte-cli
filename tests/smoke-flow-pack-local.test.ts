import { describe, expect, it } from 'vitest';
import * as smokeFlowPackLocal from '../src/smoke/flow-pack-local';

describe('local flow-pack smoke classifier', () => {
  it('treats known data-gated sendCommand 422 as pass', async () => {
    const classified = smokeFlowPackLocal.classifyStep('send_command_write', {
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
    const classified = smokeFlowPackLocal.classifyStep(
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
    const classified = smokeFlowPackLocal.classifyStep(
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
