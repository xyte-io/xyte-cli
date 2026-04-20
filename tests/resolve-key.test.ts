import { describe, expect, it } from 'vitest';

import { resolveKeyValue } from '../src/cli/resolve-key';
import { CliUserError } from '../src/contracts/user-error';

function makeArgs(overrides: Record<string, unknown> = {}) {
  const stdout = { write: () => true } as { write: (s: string) => boolean };
  return {
    prompt: async () => '',
    readStdin: async () => '',
    runCommand: async () => ({ code: 0, stdout: '', stderr: '' }),
    promptQuestion: 'Enter key:',
    stdout,
    ...overrides
  };
}

describe('resolveKeyValue', () => {
  it('returns inline key when provided', async () => {
    const result = await resolveKeyValue(makeArgs({ key: 'my-key' }));
    expect(result).toBe('my-key');
  });

  it('trims inline key whitespace', async () => {
    const result = await resolveKeyValue(makeArgs({ key: '  trimmed  ' }));
    expect(result).toBe('trimmed');
  });

  it('reads from stdin when keyStdin is true', async () => {
    const result = await resolveKeyValue(makeArgs({ keyStdin: true, readStdin: async () => 'stdin-key\n' }));
    expect(result).toBe('stdin-key');
  });

  it('returns undefined for empty stdin', async () => {
    const result = await resolveKeyValue(makeArgs({ keyStdin: true, readStdin: async () => '  ' }));
    expect(result).toBeUndefined();
  });

  it('throws CliUserError when both key and keyStdin are provided', async () => {
    await expect(resolveKeyValue(makeArgs({ key: 'k', keyStdin: true }))).rejects.toThrow(CliUserError);
  });

  it('returns env key when no inline or stdin key', async () => {
    const result = await resolveKeyValue(makeArgs({ envKey: 'env-key' }));
    expect(result).toBe('env-key');
  });

  it('trims env key whitespace', async () => {
    const result = await resolveKeyValue(makeArgs({ envKey: '  env-trimmed  ' }));
    expect(result).toBe('env-trimmed');
  });

  it('prompts when allowPrompt is true and no other source', async () => {
    const result = await resolveKeyValue(
      makeArgs({
        allowPrompt: true,
        prompt: async () => 'prompted-key'
      })
    );
    expect(result).toBe('prompted-key');
  });

  it('returns undefined for empty prompted value', async () => {
    const result = await resolveKeyValue(
      makeArgs({
        allowPrompt: true,
        prompt: async () => '  '
      })
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when no sources are available', async () => {
    const result = await resolveKeyValue(makeArgs());
    expect(result).toBeUndefined();
  });

  it('prioritizes inline key over env key', async () => {
    const result = await resolveKeyValue(makeArgs({ key: 'inline', envKey: 'env' }));
    expect(result).toBe('inline');
  });

  it('prioritizes env key over prompt', async () => {
    const result = await resolveKeyValue(
      makeArgs({
        envKey: 'env',
        allowPrompt: true,
        prompt: async () => 'prompted'
      })
    );
    expect(result).toBe('env');
  });

  describe('--key-command', () => {
    it('runs the command and uses stdout as the key', async () => {
      const result = await resolveKeyValue(
        makeArgs({
          keyCommand: 'op read op://vault/item/field',
          runCommand: async () => ({ code: 0, stdout: 'secret-from-op\n', stderr: '' })
        })
      );
      expect(result).toBe('secret-from-op');
    });

    it('passes the command string through to runCommand verbatim', async () => {
      let seen = '';
      await resolveKeyValue(
        makeArgs({
          keyCommand: 'my helper --flag=x',
          runCommand: async (cmd: string) => {
            seen = cmd;
            return { code: 0, stdout: 'val', stderr: '' };
          }
        })
      );
      expect(seen).toBe('my helper --flag=x');
    });

    it('trims stdout whitespace', async () => {
      const result = await resolveKeyValue(
        makeArgs({
          keyCommand: 'echo',
          runCommand: async () => ({ code: 0, stdout: '  spaced-key\r\n', stderr: '' })
        })
      );
      expect(result).toBe('spaced-key');
    });

    it('returns undefined when command prints nothing', async () => {
      const result = await resolveKeyValue(
        makeArgs({
          keyCommand: 'true',
          runCommand: async () => ({ code: 0, stdout: '', stderr: '' })
        })
      );
      expect(result).toBeUndefined();
    });

    it('throws CliUserError when command exits non-zero', async () => {
      await expect(
        resolveKeyValue(
          makeArgs({
            keyCommand: 'op read op://missing',
            runCommand: async () => ({ code: 1, stdout: '', stderr: 'item not found' })
          })
        )
      ).rejects.toThrow(CliUserError);
    });

    it('does not include stdout or stderr in error detail on non-zero exit', async () => {
      try {
        await resolveKeyValue(
          makeArgs({
            keyCommand: 'buggy',
            runCommand: async () => ({ code: 2, stdout: 'partial-secret', stderr: 'stderr-secret' })
          })
        );
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(CliUserError);
        const detail = (error as CliUserError).detail ?? '';
        expect(detail).toBe('exit 2');
        expect(detail).not.toContain('partial-secret');
        expect(detail).not.toContain('stderr-secret');
      }
    });

    it('throws CliUserError when the command runner rejects before an exit code is available', async () => {
      await expect(
        resolveKeyValue(
          makeArgs({
            keyCommand: 'op read op://vault/item/field',
            runCommand: async () => {
              throw new Error('spawn ENOMEM');
            }
          })
        )
      ).rejects.toMatchObject({
        summary: 'API key command failed to start.',
        detail: 'spawn ENOMEM'
      });
    });

    it('conflicts with --key', async () => {
      await expect(
        resolveKeyValue(makeArgs({ key: 'inline', keyCommand: 'op read' }))
      ).rejects.toThrow(CliUserError);
    });

    it('conflicts with --key-file', async () => {
      await expect(
        resolveKeyValue(makeArgs({ keyFile: '/tmp/x', keyCommand: 'op read' }))
      ).rejects.toThrow(CliUserError);
    });

    it('conflicts with --key-stdin', async () => {
      await expect(
        resolveKeyValue(makeArgs({ keyStdin: true, keyCommand: 'op read' }))
      ).rejects.toThrow(CliUserError);
    });

    it('takes precedence over env key and prompt', async () => {
      const result = await resolveKeyValue(
        makeArgs({
          keyCommand: 'op read op://vault/item/field',
          runCommand: async () => ({ code: 0, stdout: 'from-command', stderr: '' }),
          envKey: 'env-key',
          allowPrompt: true,
          prompt: async () => 'prompted'
        })
      );
      expect(result).toBe('from-command');
    });
  });
});
