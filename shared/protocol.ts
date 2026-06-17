export type ToolCall = { id: string; name: string; input: unknown }
export type Usage = { inputTokens?: number; outputTokens?: number; costUsd?: number }

export type ClientMsg =
  | { type: 'user_message'; text: string }
  | { type: 'permission_response'; requestId: string; decision: 'allow' | 'deny' }
  | { type: 'interrupt' }

export type ServerMsg =
  | { type: 'assistant_delta'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; result: unknown }
  | { type: 'permission_request'; requestId: string; name: string; input: unknown }
  | { type: 'turn_done'; usage?: Usage }
  | { type: 'error'; message: string }

export function parseClientMsg(raw: string): ClientMsg | null {
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  switch (o.type) {
    case 'user_message':
      return typeof o.text === 'string' ? { type: 'user_message', text: o.text } : null
    case 'permission_response':
      return typeof o.requestId === 'string' && (o.decision === 'allow' || o.decision === 'deny')
        ? { type: 'permission_response', requestId: o.requestId, decision: o.decision }
        : null
    case 'interrupt':
      return { type: 'interrupt' }
    default:
      return null
  }
}
