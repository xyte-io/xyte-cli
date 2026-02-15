import { createOpenAIAdapter } from './adapters/openai';
import { createAnthropicAdapter } from './adapters/anthropic';
import { createOpenAICompatibleAdapter } from './adapters/openai-compatible';
import type { KeychainStore } from '../secure/keychain';
import { createKeychainStore } from '../secure/keychain';
import type { ProfileStore } from '../secure/profile-store';
import { FileProfileStore } from '../secure/profile-store';
import type { SecretProvider } from '../types/profile';
import { extractFirstJsonObject } from '../utils/json';

export type LLMProvider = 'openai' | 'anthropic' | 'openai-compatible';

export interface LLMGenerateInput {
  system?: string;
  user: string;
  context?: unknown;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface LLMResult {
  provider: LLMProvider;
  model: string;
  text: string;
  raw: unknown;
  usage?: LLMUsage;
  json?: unknown;
}

export interface LLMProviderAdapter {
  provider: LLMProvider;
  generate(input: LLMGenerateInput, config: LLMProviderConfig): Promise<LLMResult>;
}

export interface LLMRunOptions extends LLMGenerateInput {
  tenantId?: string;
  provider?: LLMProvider;
  expectJson?: boolean;
}

export interface LLMServiceOptions {
  profileStore?: ProfileStore;
  keychain?: KeychainStore;
  adapters?: Partial<Record<LLMProvider, LLMProviderAdapter>>;
}

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-3-5-haiku-latest',
  'openai-compatible': 'llama3.2'
};

function providerToSecret(provider: LLMProvider): SecretProvider {
  if (provider === 'openai') {
    return 'openai';
  }
  if (provider === 'anthropic') {
    return 'anthropic';
  }
  return 'openai-compatible';
}

export class LLMService {
  private readonly profileStore: ProfileStore;
  private readonly adapters: Record<LLMProvider, LLMProviderAdapter>;
  private readonly explicitKeychain?: KeychainStore;
  private keychainPromise?: Promise<KeychainStore>;

  constructor(options: LLMServiceOptions = {}) {
    this.profileStore = options.profileStore ?? new FileProfileStore();
    this.explicitKeychain = options.keychain;
    this.adapters = {
      openai: options.adapters?.openai ?? createOpenAIAdapter(),
      anthropic: options.adapters?.anthropic ?? createAnthropicAdapter(),
      'openai-compatible': options.adapters?.['openai-compatible'] ?? createOpenAICompatibleAdapter()
    };
  }

  async run(options: LLMRunOptions): Promise<LLMResult> {
    const profileData = await this.profileStore.getData();
    const tenantId = options.tenantId ?? profileData.activeTenantId;
    const tenant = tenantId ? await this.profileStore.getTenant(tenantId) : undefined;

    const provider =
      options.provider ??
      tenant?.defaultLLMProvider ??
      profileData.globalDefaultLLMProvider ??
      'openai';

    const model =
      options.model ?? tenant?.defaultLLMModel ?? profileData.globalDefaultLLMModel ?? DEFAULT_MODELS[provider];

    const keychain = await this.getKeychain();
    const secretProvider = providerToSecret(provider);
    let apiKey: string | undefined;
    if (tenantId) {
      const activeSlot = await this.profileStore.getActiveKeySlot(tenantId, secretProvider);
      apiKey = await keychain.getSlotSecret(tenantId, secretProvider, activeSlot?.slotId ?? 'default');
    }

    const result = await this.adapters[provider].generate(options, {
      apiKey,
      baseUrl: provider === 'openai-compatible' ? tenant?.openaiCompatibleBaseUrl : undefined,
      model,
      temperature: options.temperature,
      maxTokens: options.maxTokens
    });

    if (options.expectJson) {
      result.json = extractFirstJsonObject(result.text);
    }

    return result;
  }

  private async getKeychain(): Promise<KeychainStore> {
    if (this.explicitKeychain) {
      return this.explicitKeychain;
    }
    if (!this.keychainPromise) {
      this.keychainPromise = createKeychainStore();
    }
    return this.keychainPromise;
  }
}
