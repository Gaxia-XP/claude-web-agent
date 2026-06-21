import type { ServerMsg, StoredMessage, Usage } from '../../shared/protocol'
import type { Provider, TurnParams } from '../providers/types'
import type { ProviderConfig } from '../providers/index'
import type { DB } from '../store'
import { PolicyPermissionResolver, type PermissionPolicy } from '../permission'
import { runTurn } from '../agent'
import { parseModelId, resolveConnectionByName, connectionToProviderConfig } from './models'

export type CompatMessage = { role: 'system' | 'user' | 'assistant'; content: string }
export type CompatDeps = { db: DB; makeProvider: (cfg: ProviderConfig) => Provider }

// Carries the HTTP status the compat endpoints return for resolution failures.
export class CompatError extends Error {
  constructor(public status: number, message: string) {
    super(message)
    this.name = 'CompatError'
  }
}

// Convert incoming compat messages -> TurnParams. Last user message -> userText (local-agent);
// full user/assistant transcript -> history (anthropic-api / openai-compatible). System messages
// are dropped (documented M5 limitation).
export function compatMessagesToTurnParams(messages: CompatMessage[], model: string): TurnParams {
  const convo = messages.filter((m): m is CompatMessage & { role: 'user' | 'assistant' } =>
    m.role === 'user' || m.role === 'assistant',
  )
  const lastUser = [...convo].reverse().find((m) => m.role === 'user')
  const history: StoredMessage[] = convo.map((m, i) => ({
    id: `compat-${i}`,
    role: m.role,
    content: [{ type: 'text', text: m.content }],
    createdAt: 0,
  }))
  return { userText: lastUser?.content ?? '', history, model }
}

// Resolve provider + policy + model from a compat model id. Throws CompatError (404/400).
export function resolveCompatTurn(
  deps: CompatDeps,
  modelId: string,
): { provider: Provider; policy: PermissionPolicy; model: string } {
  const parsed = parseModelId(modelId)
  if (!parsed) throw new CompatError(404, `model not found: ${modelId}`)
  const conn = resolveConnectionByName(deps.db, parsed.connName)
  if (!conn) throw new CompatError(404, `unknown connection: ${parsed.connName}`)
  let provider: Provider
  try {
    provider = deps.makeProvider(connectionToProviderConfig(conn, parsed.model))
  } catch (err) {
    throw new CompatError(400, err instanceof Error ? err.message : String(err))
  }
  return { provider, policy: parsed.policy, model: parsed.model }
}

// Run one stateless turn through the shared runTurn. Streams assistant text via onDelta. Returns the
// final text (TurnResult.text), usage, and any provider error. Intermediate tool_call/tool_result/
// turn_done events are dropped — compat surfaces only the final answer.
export async function executeCompatTurn(args: {
  provider: Provider
  policy: PermissionPolicy
  model: string
  messages: CompatMessage[]
  signal: AbortSignal
  onDelta?: (text: string) => void
}): Promise<{ text: string; usage?: Usage; error?: string }> {
  const params = compatMessagesToTurnParams(args.messages, args.model)
  const resolver = new PolicyPermissionResolver(args.policy)
  let error: string | undefined
  const send = (m: ServerMsg): void => {
    if (m.type === 'assistant_delta') args.onDelta?.(m.text)
    else if (m.type === 'error') error = m.message
  }
  const result = await runTurn(args.provider, params, {
    chatId: 'compat',
    send,
    permission: resolver,
    signal: args.signal,
  })
  return { text: result.text, usage: result.usage, error }
}
