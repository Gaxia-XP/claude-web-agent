import type { ServerMsg } from '../shared/protocol'
import type { PermissionResolver } from './permission'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './providers/types'

export interface RunDeps {
  chatId: string
  send: (m: ServerMsg) => void
  permission: PermissionResolver
  signal: AbortSignal
  turnTimeoutMs?: number
}

const DEFAULT_TURN_TIMEOUT_MS = 600_000

/** Sentinel resolved by the watchdog when the turn exceeds turnTimeoutMs. */
const TIMED_OUT = Symbol('runTurn:timed-out')

export async function runTurn(provider: Provider, params: TurnParams, deps: RunDeps): Promise<TurnResult> {
  const { chatId } = deps
  const timeoutMs = deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS

  let emitted = false
  const ctx: ProviderContext = {
    onDelta: (text) => {
      emitted = true
      deps.send({ type: 'assistant_delta', chatId, text })
    },
    onToolCall: (c) => deps.send({ type: 'tool_call', chatId, id: c.id, name: c.name, input: c.input }),
    onToolResult: (id, result) => deps.send({ type: 'tool_result', chatId, id, result }),
    permission: deps.permission,
    signal: deps.signal,
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs)
  })

  try {
    const raced = await Promise.race([provider.send(params, ctx), timeoutPromise])

    if (raced === TIMED_OUT) {
      deps.send({ type: 'error', chatId, message: 'turn timed out' })
      deps.send({ type: 'turn_done', chatId })
      return { text: '' }
    }

    const result = raced
    if (!emitted && result.text) {
      deps.send({ type: 'assistant_delta', chatId, text: result.text })
    }
    deps.send({ type: 'turn_done', chatId, usage: result.usage })
    return result
  } catch (err) {
    deps.send({ type: 'error', chatId, message: err instanceof Error ? err.message : String(err) })
    deps.send({ type: 'turn_done', chatId })
    return { text: '' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
