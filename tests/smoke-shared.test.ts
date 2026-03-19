import { describe, expect, it } from 'vitest';

import { buildSpawnPlan } from '../src/smoke/shared';

describe('smoke shared runner', () => {
  it('uses direct spawning for non-Windows commands', () => {
    const plan = buildSpawnPlan('xyte-cli', ['config', 'tenant', 'add', 'acme'], 'darwin');

    expect(plan).toEqual({
      command: 'xyte-cli',
      args: ['config', 'tenant', 'add', 'acme'],
      shell: false
    });
  });

  it('routes cmd shims through cmd.exe with quoted spaced arguments', () => {
    const plan = buildSpawnPlan(
      'xyte-cli.cmd',
      ['config', 'tenant', 'add', 'acme', '--name', 'Acme Mock', '--hub-url', 'http://127.0.0.1:43123'],
      'win32'
    );

    expect(plan.command.toLowerCase()).toContain('cmd');
    expect(plan.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(plan.args[3]).toBe(
      'xyte-cli.cmd config tenant add acme --name "Acme Mock" --hub-url http://127.0.0.1:43123'
    );
    expect(plan.shell).toBe(false);
  });
});
