import type { LLMGenerateInput, LLMProviderAdapter, LLMProviderConfig, LLMResult } from '../provider';

function endpointFor(baseUrl: string): string {
  const root = baseUrl.replace(/\/$/, '');
  if (root.endsWith('/v1')) {
    return `${root}/chat/completions`;
  }
  return `${root}/v1/chat/completions`;
}

function flattenChoiceMessage(raw: any): string {
  const message = raw?.choices?.[0]?.message?.content;
  if (typeof message === 'string') {
    return message;
  }

  if (Array.isArray(message)) {
    return message
      .map((item) => {
        if (typeof item === 'string') {
          return item;
        }
        if (item?.type === 'text' && typeof item?.text === 'string') {
          return item.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

function buildMessages(input: LLMGenerateInput): Array<{ role: 'system' | 'user'; content: string }> {
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (input.system) {
    messages.push({ role: 'system', content: input.system });
  }
  const contextText = input.context === undefined ? '' : `\n\nContext:\n${JSON.stringify(input.context, null, 2)}`;
  messages.push({ role: 'user', content: `${input.user}${contextText}` });
  return messages;
}

export function createOpenAICompatibleAdapter(): LLMProviderAdapter {
  return {
    provider: 'openai-compatible',
    async generate(input: LLMGenerateInput, config: LLMProviderConfig): Promise<LLMResult> {
      const baseUrl = config.baseUrl ?? 'http://localhost:11434';
      const response = await fetch(endpointFor(baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: config.model,
          temperature: config.temperature,
          max_tokens: config.maxTokens,
          messages: buildMessages(input)
        })
      });

      const raw = await response.json();
      if (!response.ok) {
        throw new Error(`OpenAI-compatible request failed (${response.status}): ${JSON.stringify(raw)}`);
      }

      return {
        provider: 'openai-compatible',
        model: config.model,
        text: flattenChoiceMessage(raw),
        raw,
        usage: {
          inputTokens: raw?.usage?.prompt_tokens,
          outputTokens: raw?.usage?.completion_tokens,
          totalTokens: raw?.usage?.total_tokens
        }
      };
    }
  };
}
