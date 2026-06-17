import type { ServerMsg } from '../shared/protocol'
import type { PermissionResolver } from './permission'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './providers/types'

export interface RunDeps {
  send: (m: ServerMsg) => void
  permission: PermissionResolver
  signal: AbortSignal
}

export async function runTurn(provider: Provider, params: TurnParams, deps: RunDeps): Promise<TurnResult> {
  const ctx: ProviderContext = {
    onDelta: (text) => deps.send({ type: 'assistant_delta', text }),
    onToolCall: (c) => deps.send({ type: 'tool_call', id: c.id, name: c.name, input: c.input }),
    onToolResult: (id, result) => deps.send({ type: 'tool_result', id, result }),
    permission: deps.permission,
    signal: deps.signal,
  }
  try {
    const result = await provider.send(params, ctx)
    deps.send({ type: 'turn_done', usage: result.usage })
    return result
  } catch (err) {
    deps.send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    deps.send({ type: 'turn_done' })
    return { text: '' }
  }
}
