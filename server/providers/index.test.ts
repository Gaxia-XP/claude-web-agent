import { describe, it, expect } from 'vitest'
import { makeProvider } from './index'
import { LocalAgentProvider } from './localAgent'
import { AnthropicApiProvider } from './anthropicApi'
import { OpenAICompatibleProvider } from './openaiCompat'

describe('makeProvider', () => {
  it('returns LocalAgentProvider for local-agent', () => {
    const p = makeProvider({ type: 'local-agent', defaultModel: 'sonnet' })
    expect(p).toBeInstanceOf(LocalAgentProvider)
    expect(p.type).toBe('local-agent')
  })
  it('returns AnthropicApiProvider for anthropic-api', () => {
    const p = makeProvider({ type: 'anthropic-api', apiKey: 'sk', defaultModel: 'claude-opus-4-8' })
    expect(p).toBeInstanceOf(AnthropicApiProvider)
    expect(p.type).toBe('anthropic-api')
  })
  it('returns OpenAICompatibleProvider for openai-compatible', () => {
    const p = makeProvider({ type: 'openai-compatible', baseUrl: 'https://x/v1', apiKey: 'k', defaultModel: 'm' })
    expect(p).toBeInstanceOf(OpenAICompatibleProvider)
    expect(p.type).toBe('openai-compatible')
  })
  it('throws when anthropic-api has no apiKey', () => {
    expect(() => makeProvider({ type: 'anthropic-api', defaultModel: 'm' })).toThrow(/api key/i)
  })
  it('throws when openai-compatible has no baseUrl', () => {
    expect(() => makeProvider({ type: 'openai-compatible', apiKey: 'k', defaultModel: 'm' })).toThrow(/base url/i)
  })
  it('throws for unknown type', () => {
    expect(() => makeProvider({ type: 'nope', defaultModel: 'm' })).toThrow(/unknown provider type/i)
  })
})
