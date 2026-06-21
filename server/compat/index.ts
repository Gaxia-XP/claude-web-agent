import type { FastifyInstance } from 'fastify'
import { registerOpenAiCompat } from './openai'
import { registerAnthropicCompat } from './anthropic'
import type { CompatDeps } from './turn'

// Compatibility API (M5): OpenAI (/v1/models, /v1/chat/completions) + Anthropic (/v1/messages).
// Stateless — does NOT touch ChatHub/ChatRuntime. Auth + 0.0.0.0 bind are M6.
export function registerCompatApi(app: FastifyInstance, deps: CompatDeps): void {
  registerOpenAiCompat(app, deps)
  registerAnthropicCompat(app, deps)
}

export type { CompatDeps } from './turn'
