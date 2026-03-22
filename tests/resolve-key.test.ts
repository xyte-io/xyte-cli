import { describe, expect, it } from 'vitest';

import { resolveKeyValue } from '../src/cli/resolve-key';
import { CliUserError } from '../src/contracts/user-error';

function makeArgs(overrides: Record<string, unknown> = {}) {
  const stdout = { write: () => true } as { write: (s: string) => boolean };
  return {
    prompt: async () => '',
    readStdin: async () => '',
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
});
