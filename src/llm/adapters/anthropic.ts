import type { LLMGenerateInput, LLMProviderAdapter, LLMProviderConfig, LLMResult } from '../provider';

function buildUserText(input: LLMGenerateInput): string {
  if (input.context === undefined) {
    return input.user;
  }
  return `${input.user}\n\nContext:\n${JSON.stringify(input.context, null, 2)}`;
}

function flattenText(raw: any): string {
  const content = raw?.content;
  if (!Array.isArray(content)) {
    return '';
  }

  const chunks: string[] = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block?.text === 'string') {
      chunks.push(block.text);
    }
  }

  return chunks.join('\n').trim();
}

export function createAnthropicAdapter(): LLMProviderAdapter {
  return {
    provider: 'anthropic',
    async generate(input: LLMGenerateInput, config: LLMProviderConfig): Promise<LLMResult> {
      if (!config.apiKey) {
        throw new Error('Missing Anthropic API key for selected tenant/provider.');
      }

      const url = `${(config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens ?? 1024,
          temperature: config.temperature,
          system: input.system,
          messages: [
            {
              role: 'user',
              content: buildUserText(input)
            }
          ]
        })
      });

      const raw = await response.json();
      if (!response.ok) {
        throw new Error(`Anthropic request failed (${response.status}): ${JSON.stringify(raw)}`);
      }

      return {
        provider: 'anthropic',
        model: config.model,
        text: flattenText(raw),
        raw,
        usage: {
          inputTokens: raw?.usage?.input_tokens,
          outputTokens: raw?.usage?.output_tokens
        }
      };
    }
  };
}
