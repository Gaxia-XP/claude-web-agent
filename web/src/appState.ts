import type {
  ServerMsg,
  ToolCall,
  ChatMeta,
  StoredMessage,
  DirEntry,
} from '@shared/protocol'

export type UiMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; tools: ToolCall[] }
  | { role: 'error'; text: string }

export type PermissionPrompt = {
  chatId: string
  requestId: string
  name: string
  input: unknown
}

export type ChatView = { messages: UiMessage[]; streaming: boolean }

export type FolderPickerState = {
  open: boolean
  path: string
  parent?: string
  entries: DirEntry[]
  error?: string
}

export type AppState = {
  chats: ChatMeta[]
  activeChatId?: string
  views: Record<string, ChatView>
  pending?: PermissionPrompt
  folder?: FolderPickerState
}

export const initialAppState: AppState = { chats: [], views: {} }

const emptyView: ChatView = { messages: [], streaming: false }

function getView(state: AppState, chatId: string): ChatView {
  return state.views[chatId] ?? emptyView
}

function ensureAssistant(view: ChatView): { messages: UiMessage[]; idx: number } {
  const last = view.messages[view.messages.length - 1]
  if (last && last.role === 'assistant') {
    return { messages: [...view.messages], idx: view.messages.length - 1 }
  }
  const messages = [...view.messages, { role: 'assistant' as const, text: '', tools: [] }]
  return { messages, idx: messages.length - 1 }
}

// Per-view reduction — mirrors the M1 single-chat logic, scoped to one ChatView.
// Returns the SAME view reference when nothing changes (e.g. tool_result).
// Only ever called for the per-chat ServerMsg variants whose chatId has been
// narrowed to a string by the caller.
function reduceView(view: ChatView, msg: ServerMsg): ChatView {
  switch (msg.type) {
    case 'assistant_delta': {
      const { messages, idx } = ensureAssistant(view)
      const cur = messages[idx] as Extract<UiMessage, { role: 'assistant' }>
      messages[idx] = { ...cur, text: cur.text + msg.text }
      return { ...view, messages }
    }
    case 'tool_call': {
      const { messages, idx } = ensureAssistant(view)
      const cur = messages[idx] as Extract<UiMessage, { role: 'assistant' }>
      messages[idx] = {
        ...cur,
        tools: [...cur.tools, { id: msg.id, name: msg.name, input: msg.input }],
      }
      return { ...view, messages }
    }
    case 'tool_result':
      return view // ignored for render (tool results shown as cards only)
    case 'turn_done':
      return { ...view, streaming: false }
    case 'error':
      // Always surface errors as their own message so failures before the
      // first assistant token are visible and never misattributed to a
      // previous turn's answer.
      return { ...view, messages: [...view.messages, { role: 'error', text: msg.message }] }
    default:
      return view
  }
}

function setView(state: AppState, chatId: string, view: ChatView): AppState {
  return { ...state, views: { ...state.views, [chatId]: view } }
}

function historyToView(messages: StoredMessage[]): ChatView {
  const ui: UiMessage[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const first = m.content.find((b) => b.type === 'text')
      ui.push({ role: 'user', text: first && first.type === 'text' ? first.text : '' })
    } else {
      let text = ''
      const tools: ToolCall[] = []
      for (const b of m.content) {
        if (b.type === 'text') text += b.text
        else if (b.type === 'tool_use') tools.push({ id: b.id, name: b.name, input: b.input })
        // tool_result blocks are ignored for render
      }
      ui.push({ role: 'assistant', text, tools })
    }
  }
  return { messages: ui, streaming: false }
}

export function applyServer(state: AppState, msg: ServerMsg): AppState {
  switch (msg.type) {
    case 'chat_list':
      return { ...state, chats: msg.chats }
    case 'chat_created':
      return {
        ...state,
        chats: [...state.chats, msg.chat],
        activeChatId: msg.chat.id,
        views: { ...state.views, [msg.chat.id]: { messages: [], streaming: false } },
      }
    case 'chat_renamed':
      return {
        ...state,
        chats: state.chats.map((c) => (c.id === msg.chatId ? { ...c, title: msg.title } : c)),
      }
    case 'chat_deleted': {
      const views = { ...state.views }
      delete views[msg.chatId]
      return {
        ...state,
        chats: state.chats.filter((c) => c.id !== msg.chatId),
        views,
        activeChatId: state.activeChatId === msg.chatId ? undefined : state.activeChatId,
      }
    }
    case 'chat_history':
      return setView(state, msg.chatId, historyToView(msg.messages))
    case 'permission_request':
      return {
        ...state,
        pending: {
          chatId: msg.chatId,
          requestId: msg.requestId,
          name: msg.name,
          input: msg.input,
        },
      }
    case 'dir_list':
      return {
        ...state,
        folder: {
          open: true,
          path: msg.path,
          parent: msg.parent,
          entries: msg.entries,
          error: undefined, // clear any prior error on a successful listing
        },
      }
    case 'error': {
      // error{chatId?}: optional chatId. A chat-less global error has no view
      // to attach to. If the FolderPicker is open, surface it there; otherwise
      // drop it (state unchanged). Handled separately from the combined per-chat
      // case because its chatId is string | undefined.
      if (msg.chatId === undefined) {
        if (state.folder?.open) {
          return { ...state, folder: { ...state.folder, error: msg.message } }
        }
        return state
      }
      const view = getView(state, msg.chatId)
      const next = reduceView(view, msg)
      return next === view ? state : setView(state, msg.chatId, next)
    }
    case 'assistant_delta':
    case 'tool_call':
    case 'tool_result':
    case 'turn_done': {
      const view = getView(state, msg.chatId)
      const next = reduceView(view, msg)
      if (next === view) return state // nothing changed (e.g. tool_result)
      return setView(state, msg.chatId, next)
    }
  }
}

export function appendUser(state: AppState, chatId: string, text: string): AppState {
  const view = getView(state, chatId)
  return setView(state, chatId, {
    messages: [...view.messages, { role: 'user', text }],
    streaming: true,
  })
}

export function setActiveChat(state: AppState, chatId: string): AppState {
  return { ...state, activeChatId: chatId }
}

export function clearPending(state: AppState): AppState {
  return { ...state, pending: undefined }
}

export function closeFolder(state: AppState): AppState {
  return { ...state, folder: undefined }
}
