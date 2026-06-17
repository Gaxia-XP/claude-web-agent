import { useEffect, useReducer, useRef, useState } from 'react'
import type { ServerMsg } from '@shared/protocol'
import {
  applyServer,
  appendUser,
  dequeuePending,
  activePrompt,
  closeFolder,
  setActiveChat,
  initialAppState,
  type AppState,
} from './appState'
import { createWsClient, type WsStatus } from './ws'
import { Sidebar } from './components/Sidebar'
import { FolderPicker } from './components/FolderPicker'
import { Message } from './components/Message'
import { Composer } from './components/Composer'
import { PermissionModal } from './components/PermissionModal'
import { NewChatModal, type NewChatDraft } from './components/NewChatModal'
import { Settings, type ConnectionFormPayload } from './components/Settings'

type Action =
  | { kind: 'server'; msg: ServerMsg }
  | { kind: 'user'; chatId: string; text: string }
  | { kind: 'setActive'; chatId: string }
  | { kind: 'dequeuePending'; requestId: string }
  | { kind: 'closeFolder' }

function reducer(state: AppState, action: Action): AppState {
  switch (action.kind) {
    case 'server':
      return applyServer(state, action.msg)
    case 'user':
      return appendUser(state, action.chatId, action.text)
    case 'setActive':
      return setActiveChat(state, action.chatId)
    case 'dequeuePending':
      return dequeuePending(state, action.requestId)
    case 'closeFolder':
      return closeFolder(state)
  }
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialAppState)
  const [status, setStatus] = useState<WsStatus>('connecting')
  const [page, setPage] = useState<'chat' | 'settings'>('chat')
  const [newChat, setNewChat] = useState<NewChatDraft | null>(null)
  const clientRef = useRef<ReturnType<typeof createWsClient> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  const activeChatRef = useRef<string | undefined>(undefined)
  activeChatRef.current = state.activeChatId

  useEffect(() => {
    const client = createWsClient({
      onMessage: (msg) => dispatch({ kind: 'server', msg }),
      onStatus: (s) => {
        setStatus(s)
        if (s === 'open' && activeChatRef.current) {
          client.send({ type: 'subscribe', chatId: activeChatRef.current })
        }
      },
    })
    clientRef.current = client
    return () => client.close()
  }, [])

  const activeId = state.activeChatId
  const view = activeId ? state.views[activeId] : undefined

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [view?.messages])

  const selectChat = (id: string) => {
    dispatch({ kind: 'setActive', chatId: id })
    clientRef.current?.send({ type: 'subscribe', chatId: id })
  }

  const defaultDraft = (): NewChatDraft => {
    const first = state.connections[0]
    return { connectionId: first?.id ?? 'local', model: first?.defaultModel ?? 'sonnet' }
  }
  const openNewChat = () => setNewChat(defaultDraft())
  const submitNewChat = () => {
    if (!newChat) return
    const conn = state.connections.find((c) => c.id === newChat.connectionId)
    const isLocal = (conn?.type ?? 'local-agent') === 'local-agent'
    clientRef.current?.send({
      type: 'create_chat',
      connectionId: newChat.connectionId,
      model: newChat.model,
      ...(isLocal && newChat.cwd ? { cwd: newChat.cwd } : {}),
    })
    setNewChat(null)
    dispatch({ kind: 'closeFolder' })
  }

  const renameChat = (id: string, title: string) => clientRef.current?.send({ type: 'rename_chat', chatId: id, title })
  const deleteChat = (id: string) => clientRef.current?.send({ type: 'delete_chat', chatId: id })

  const send = (text: string) => {
    if (!activeId) return
    dispatch({ kind: 'user', chatId: activeId, text })
    clientRef.current?.send({ type: 'user_message', chatId: activeId, text })
  }
  const stop = () => {
    if (!activeId) return
    clientRef.current?.send({ type: 'interrupt', chatId: activeId })
  }

  // FolderPicker is only used to browse a cwd for the NewChatModal draft.
  const browseFolder = (path: string) => clientRef.current?.send({ type: 'list_dirs', path })
  const openBrowse = () => clientRef.current?.send({ type: 'list_dirs', path: newChat?.cwd })
  const chooseFolder = (path: string) => {
    setNewChat((d) => (d ? { ...d, cwd: path } : d))
    dispatch({ kind: 'closeFolder' })
  }
  const cancelFolder = () => dispatch({ kind: 'closeFolder' })

  const prompt = activePrompt(state)
  const decide = (decision: 'allow' | 'deny') => {
    if (!prompt) return
    clientRef.current?.send({ type: 'permission_response', requestId: prompt.requestId, decision })
    dispatch({ kind: 'dequeuePending', requestId: prompt.requestId })
  }

  const createConnection = (p: ConnectionFormPayload) =>
    clientRef.current?.send({
      type: 'create_connection',
      name: p.name,
      providerType: p.providerType,
      defaultModel: p.defaultModel,
      ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
      ...(p.apiKey ? { apiKey: p.apiKey } : {}),
    })
  const updateConnection = (
    id: string,
    patch: { name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string },
  ) => clientRef.current?.send({ type: 'update_connection', id, ...patch })
  const deleteConnection = (id: string) => clientRef.current?.send({ type: 'delete_connection', id })

  if (page === 'settings') {
    return (
      <div className="flex h-full">
        <Settings
          connections={state.connections}
          chats={state.chats}
          error={state.lastError}
          onCreate={createConnection}
          onUpdate={updateConnection}
          onDelete={deleteConnection}
          onClose={() => setPage('chat')}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full">
      <Sidebar
        chats={state.chats}
        activeChatId={activeId}
        onSelect={selectChat}
        onNew={openNewChat}
        onRename={renameChat}
        onDelete={deleteChat}
      />
      <div className="flex h-full flex-1 flex-col">
        <header className="flex items-center justify-between border-b bg-white px-4 py-3">
          <span className="text-lg font-semibold">Claude Web Agent</span>
          <div className="flex items-center gap-2">
            {status === 'closed' && (
              <span className="rounded bg-yellow-100 px-2 py-1 text-xs text-yellow-800">
                การเชื่อมต่อหลุด กำลังเชื่อมต่อใหม่…
              </span>
            )}
            <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={() => setPage('settings')}>
              ⚙ Settings
            </button>
          </div>
        </header>
        {activeId && view ? (
          <>
            <div ref={scrollRef} className="flex-1 overflow-y-auto bg-gray-50">
              {view.messages.map((m, i) => (
                <Message key={i} msg={m} />
              ))}
            </div>
            <Composer disabled={view.streaming} onSend={send} onStop={stop} />
          </>
        ) : activeId ? (
          <div className="flex flex-1 items-center justify-center bg-gray-50 text-gray-400">กำลังโหลด…</div>
        ) : (
          <div className="flex flex-1 items-center justify-center bg-gray-50 text-gray-500">
            <div className="text-center">
              <p className="text-base">ยังไม่มีแชทที่เลือก</p>
              <button className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-white" onClick={openNewChat}>
                + สร้างแชทใหม่
              </button>
            </div>
          </div>
        )}
      </div>
      {newChat && (
        <NewChatModal
          draft={newChat}
          connections={state.connections}
          onChange={setNewChat}
          onBrowse={openBrowse}
          onSubmit={submitNewChat}
          onClose={() => {
            setNewChat(null)
            dispatch({ kind: 'closeFolder' })
          }}
        />
      )}
      {/* FolderPicker only renders while a new-chat draft is open → a stale dir_list
          after cancel cannot resurrect the picker (NIT). */}
      {newChat && state.folder?.open && (
        <FolderPicker state={state.folder} onBrowse={browseFolder} onChoose={chooseFolder} onClose={cancelFolder} />
      )}
      {prompt && <PermissionModal prompt={prompt} onDecide={decide} />}
    </div>
  )
}
