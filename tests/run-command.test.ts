import { describe, expect, it } from 'vitest';

import { runProcess } from '../src/utils/run-command';

describe('runProcess', () => {
  it('captures stdout', async () => {
    const result = await runProcess('echo', ['hello']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.code).toBe(0);
  });

  it('captures stderr', async () => {
    const result = await runProcess('sh', ['-c', 'echo err >&2']);
    expect(result.stderr.trim()).toBe('err');
  });

  it('returns non-zero exit code on failure', async () => {
    const result = await runProcess('sh', ['-c', 'exit 42']);
    expect(result.code).toBe(42);
  });

  it('passes input via stdin', async () => {
    const result = await runProcess('cat', [], { input: 'piped' });
    expect(result.stdout).toBe('piped');
  });
});
