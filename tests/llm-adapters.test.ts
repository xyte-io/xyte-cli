import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createOpenAIAdapter } from '../src/llm/adapters/openai';
import { createAnthropicAdapter } from '../src/llm/adapters/anthropic';
import { createOpenAICompatibleAdapter } from '../src/llm/adapters/openai-compatible';

describe('LLM adapters', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('normalizes OpenAI responses output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            output_text: 'hello from openai',
            usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    const adapter = createOpenAIAdapter();
    const result = await adapter.generate(
      { user: 'hi' },
      { apiKey: 'test-key', model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1' }
    );

    expect(result.provider).toBe('openai');
    expect(result.text).toContain('hello from openai');
    expect(result.usage?.totalTokens).toBe(14);
  });

  it('normalizes Anthropic messages output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text: 'hello from anthropic' }],
            usage: { input_tokens: 8, output_tokens: 3 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    const adapter = createAnthropicAdapter();
    const result = await adapter.generate({ user: 'hi' }, { apiKey: 'a-key', model: 'claude-3-5-haiku-latest' });

    expect(result.provider).toBe('anthropic');
    expect(result.text).toContain('hello from anthropic');
  });

  it('normalizes OpenAI-compatible output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'hello from local llm' } }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    const adapter = createOpenAICompatibleAdapter();
    const result = await adapter.generate({ user: 'hi' }, { model: 'llama3.2', baseUrl: 'http://localhost:11434' });

    expect(result.provider).toBe('openai-compatible');
    expect(result.text).toContain('hello from local llm');
    expect(result.usage?.totalTokens).toBe(7);
  });
});
