import type { LLMGenerateInput, LLMProviderAdapter, LLMProviderConfig, LLMResult } from '../provider';

function flattenOutputText(raw: any): string {
  if (typeof raw?.output_text === 'string' && raw.output_text.trim()) {
    return raw.output_text;
  }

  const output = raw?.output;
  if (!Array.isArray(output)) {
    return '';
  }

  const chunks: string[] = [];
  for (const item of output) {
    if (!Array.isArray(item?.content)) {
      continue;
    }
    for (const content of item.content) {
      if (content?.type === 'output_text' && typeof content?.text === 'string') {
        chunks.push(content.text);
      }
      if (content?.type === 'text' && typeof content?.text === 'string') {
        chunks.push(content.text);
      }
    }
  }

  return chunks.join('\n').trim();
}

function buildUserText(input: LLMGenerateInput): string {
  if (input.context === undefined) {
    return input.user;
  }
  return `${input.user}\n\nContext:\n${JSON.stringify(input.context, null, 2)}`;
}

export function createOpenAIAdapter(): LLMProviderAdapter {
  return {
    provider: 'openai',
    async generate(input: LLMGenerateInput, config: LLMProviderConfig): Promise<LLMResult> {
      if (!config.apiKey) {
        throw new Error('Missing OpenAI API key for selected tenant/provider.');
      }

      const url = `${(config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '')}/responses`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`
        },
        body: JSON.stringify({
          model: config.model,
          temperature: config.temperature,
          max_output_tokens: config.maxTokens,
          input: [
            ...(input.system
              ? [
                  {
                    role: 'system',
                    content: [{ type: 'input_text', text: input.system }]
                  }
                ]
              : []),
            {
              role: 'user',
              content: [{ type: 'input_text', text: buildUserText(input) }]
            }
          ]
        })
      });

      const raw = await response.json();
      if (!response.ok) {
        throw new Error(`OpenAI request failed (${response.status}): ${JSON.stringify(raw)}`);
      }

      const text = flattenOutputText(raw);
      return {
        provider: 'openai',
        model: config.model,
        text,
        raw,
        usage: {
          inputTokens: raw?.usage?.input_tokens,
          outputTokens: raw?.usage?.output_tokens,
          totalTokens: raw?.usage?.total_tokens
        }
      };
    }
  };
}
