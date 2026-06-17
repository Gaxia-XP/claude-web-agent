import type { ServerMsg, ToolCall } from '@shared/protocol'

export type UiMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; tools: ToolCall[] }

export type PermissionPrompt = { requestId: string; name: string; input: unknown }

export type ChatState = {
  messages: UiMessage[]
  pending?: PermissionPrompt
  streaming: boolean
}

export const initialState: ChatState = { messages: [], streaming: false }

export function appendUser(state: ChatState, text: string): ChatState {
  return { ...state, messages: [...state.messages, { role: 'user', text }], streaming: true }
}

function lastAssistant(messages: UiMessage[]): { idx: number; msg: Extract<UiMessage, { role: 'assistant' }> } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant') return { idx: i, msg: m }
  }
  return null
}

function ensureAssistant(state: ChatState): { messages: UiMessage[]; idx: number } {
  const last = state.messages[state.messages.length - 1]
  if (last && last.role === 'assistant') return { messages: state.messages, idx: state.messages.length - 1 }
  const messages = [...state.messages, { role: 'assistant' as const, text: '', tools: [] }]
  return { messages, idx: messages.length - 1 }
}

export function applyServer(state: ChatState, msg: ServerMsg): ChatState {
  switch (msg.type) {
    case 'assistant_delta': {
      const { messages, idx } = ensureAssistant(state)
      const cur = messages[idx] as Extract<UiMessage, { role: 'assistant' }>
      messages[idx] = { ...cur, text: cur.text + msg.text }
      return { ...state, messages }
    }
    case 'tool_call': {
      const { messages, idx } = ensureAssistant(state)
      const cur = messages[idx] as Extract<UiMessage, { role: 'assistant' }>
      messages[idx] = { ...cur, tools: [...cur.tools, { id: msg.id, name: msg.name, input: msg.input }] }
      return { ...state, messages }
    }
    case 'tool_result':
      return state // M1: tool results are not rendered in detail (shown as card only)
    case 'permission_request':
      return { ...state, pending: { requestId: msg.requestId, name: msg.name, input: msg.input } }
    case 'turn_done':
      return { ...state, streaming: false }
    case 'error': {
      const last = lastAssistant(state.messages)
      const note = `\n\n[error] ${msg.message}`
      if (!last) return state
      const messages = [...state.messages]
      messages[last.idx] = { ...last.msg, text: last.msg.text + note }
      return { ...state, messages }
    }
  }
}

export function clearPending(state: ChatState): ChatState {
  return { ...state, pending: undefined }
}
