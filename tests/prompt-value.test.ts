import { describe, expect, it, vi } from 'vitest';
import { PassThrough } from 'node:stream';

import { promptValue } from '../src/cli/prompt-value';

async function runPrompt(
  args: { question: string; initial?: string; secret?: boolean },
  typed: string
): Promise<{ result: string; stdoutText: string; echoText: string }> {
  const input = new PassThrough();
  const echo = new PassThrough();
  const stdout = { write: vi.fn() };

  const pending = promptValue({ ...args, stdout, input, output: echo });
  input.write(typed);
  const result = await pending;

  const stdoutText = stdout.write.mock.calls.map((call) => String(call[0])).join('');
  const echoText = String(echo.read() ?? '');
  return { result, stdoutText, echoText };
}

describe('promptValue', () => {
  it('tells the user that secret input is hidden and how to proceed', async () => {
    const { stdoutText } = await runPrompt({ question: 'XYTE API key', secret: true }, 'k-123\n');

    expect(stdoutText).toContain('XYTE API key (input hidden; paste, then press Enter): ');
  });

  it('confirms how many characters were received without echoing the secret', async () => {
    const { result, stdoutText } = await runPrompt({ question: 'XYTE API key', secret: true }, 'my-secret-key-123\n');

    expect(result).toBe('my-secret-key-123');
    expect(stdoutText).toContain('Received 17 characters.');
    expect(stdoutText).not.toContain('my-secret-key-123');
  });

  it('skips the confirmation when secret input is empty', async () => {
    const { result, stdoutText } = await runPrompt({ question: 'XYTE API key', secret: true }, '\n');

    expect(result).toBe('');
    expect(stdoutText).not.toContain('Received');
  });

  it('keeps non-secret prompts unchanged', async () => {
    const { result, stdoutText, echoText } = await runPrompt({ question: 'Tenant id' }, 'acme\n');

    expect(result).toBe('acme');
    expect(echoText).toContain('Tenant id: ');
    expect(stdoutText).not.toContain('input hidden');
    expect(stdoutText).not.toContain('Received');
  });

  it('falls back to the initial value when input is empty', async () => {
    const { result } = await runPrompt({ question: 'Tenant display name', initial: 'acme' }, '\n');

    expect(result).toBe('acme');
  });
});
