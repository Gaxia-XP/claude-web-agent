import type { Provider } from './types'
import { LocalAgentProvider } from './localAgent'
import { AnthropicApiProvider } from './anthropicApi'
import { OpenAICompatibleProvider } from './openaiCompat'

export type ProviderConfig = {
  type: string
  baseUrl?: string
  apiKey?: string
  defaultModel: string
}

export function makeProvider(cfg: ProviderConfig): Provider {
  switch (cfg.type) {
    case 'local-agent':
      return new LocalAgentProvider()
    case 'anthropic-api':
      if (!cfg.apiKey) throw new Error('anthropic-api connection requires an api key')
      return new AnthropicApiProvider({ apiKey: cfg.apiKey, defaultModel: cfg.defaultModel })
    case 'openai-compatible':
      if (!cfg.baseUrl) throw new Error('openai-compatible connection requires a base url')
      return new OpenAICompatibleProvider({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, defaultModel: cfg.defaultModel })
    default:
      throw new Error(`unknown provider type: ${cfg.type}`)
  }
}
