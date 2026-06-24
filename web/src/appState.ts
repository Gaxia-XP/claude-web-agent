import type {
  ServerMsg,
  ToolCall,
  ChatMeta,
  StoredMessage,
  DirEntry,
  ConnectionMeta,
  Usage,
} from '@shared/protocol'

export type UiMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; tools: ToolCall[]; usage?: Usage }
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
  connections: ConnectionMeta[]
  activeChatId?: string
  views: Record<string, ChatView>
  pendingQueue: PermissionPrompt[]
  folder?: FolderPickerState
  lastError?: string
}

export const initialAppState: AppState = { chats: [], connections: [], views: {}, pendingQueue: [] }

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
    case 'turn_done': {
      if (!msg.usage) return { ...view, streaming: false }
      const idx = view.messages.length - 1
      const last = view.messages[idx]
      if (!last || last.role !== 'assistant') return { ...view, streaming: false }
      const messages = [...view.messages]
      messages[idx] = { ...last, usage: msg.usage }
      return { ...view, streaming: false, messages }
    }
    case 'error':
      // Always surface errors as their own message so failures before the
      // first assistant token are visible and never misattributed to a
      // previous turn's answer. Also clear streaming so the composer spinner
      // resets even if no turn_done follows (defensive).
      return { ...view, streaming: false, messages: [...view.messages, { role: 'error', text: msg.message }] }
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
      const errors: string[] = []
      for (const b of m.content) {
        if (b.type === 'text') text += b.text
        else if (b.type === 'tool_use') tools.push({ id: b.id, name: b.name, input: b.input })
        else if (b.type === 'error') errors.push(b.message)
        // tool_result blocks are ignored for render
      }
      if (text !== '' || tools.length > 0) ui.push({ role: 'assistant', text, tools, ...(m.usage ? { usage: m.usage } : {}) })
      for (const e of errors) ui.push({ role: 'error', text: e })
    }
  }
  return { messages: ui, streaming: false }
}

export function applyServer(state: AppState, msg: ServerMsg): AppState {
  switch (msg.type) {
    case 'chat_list': {
      const views = { ...state.views }
      for (const c of msg.chats) if (!views[c.id]) views[c.id] = { messages: [], streaming: false }
      return { ...state, chats: msg.chats, views }
    }
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
        pendingQueue: state.pendingQueue.filter((p) => p.chatId !== msg.chatId),
      }
    }
    case 'chat_history': {
      // If the view is currently streaming (a live turn is in progress), do NOT replace
      // it with the persisted history snapshot — that would destroy in-flight assistant
      // deltas and reset the composer from "Stop" to "Send". Ignore the history message
      // and keep the live view intact. (Triggered when a user re-clicks an active chat.)
      const existing = state.views[msg.chatId]
      if (existing && existing.streaming) return state
      return setView(state, msg.chatId, historyToView(msg.messages))
    }
    case 'permission_request':
      return {
        ...state,
        pendingQueue: [
          ...state.pendingQueue,
          { chatId: msg.chatId, requestId: msg.requestId, name: msg.name, input: msg.input },
        ],
      }
    case 'permission_resolved':
      return { ...state, pendingQueue: state.pendingQueue.filter((p) => p.requestId !== msg.requestId) }
    case 'connection_list':
      return { ...state, connections: msg.connections, lastError: undefined }
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
      // store in lastError so the Settings page can show it. Handled separately
      // from the combined per-chat case because its chatId is string | undefined.
      if (msg.chatId === undefined) {
        if (state.folder?.open) {
          return { ...state, folder: { ...state.folder, error: msg.message } }
        }
        return { ...state, lastError: msg.message }
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

export function activePrompt(state: AppState): PermissionPrompt | undefined {
  if (state.activeChatId === undefined) return undefined
  return state.pendingQueue.find((p) => p.chatId === state.activeChatId)
}

// True while a turn is in flight (streaming) but the assistant has produced no output yet:
// the assistant bubble is created lazily on the first delta/tool, so until then the last
// message is the user's (or the view is empty). Drives the typing indicator.
export function awaitingFirstToken(view: ChatView): boolean {
  if (!view.streaming) return false
  const last = view.messages[view.messages.length - 1]
  return last === undefined || last.role === 'user'
}

export function dequeuePending(state: AppState, requestId: string): AppState {
  return { ...state, pendingQueue: state.pendingQueue.filter((p) => p.requestId !== requestId) }
}

export function closeFolder(state: AppState): AppState {
  return { ...state, folder: undefined }
}
