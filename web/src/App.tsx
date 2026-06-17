import { useEffect, useReducer, useRef, useState } from 'react'
import type { ServerMsg } from '@shared/protocol'
import {
  applyServer,
  appendUser,
  clearPending,
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

type Action =
  | { kind: 'server'; msg: ServerMsg }
  | { kind: 'user'; chatId: string; text: string }
  | { kind: 'setActive'; chatId: string }
  | { kind: 'clearPending' }
  | { kind: 'closeFolder' }

function reducer(state: AppState, action: Action): AppState {
  switch (action.kind) {
    case 'server':
      return applyServer(state, action.msg)
    case 'user':
      return appendUser(state, action.chatId, action.text)
    case 'setActive':
      return setActiveChat(state, action.chatId)
    case 'clearPending':
      return clearPending(state)
    case 'closeFolder':
      return closeFolder(state)
  }
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialAppState)
  const [status, setStatus] = useState<WsStatus>('connecting')
  const clientRef = useRef<ReturnType<typeof createWsClient> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Keep the latest activeChatId in a ref so the (stable) onStatus handler can
  // re-subscribe after a reconnect without re-creating the socket.
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
  const newChat = () => clientRef.current?.send({ type: 'list_dirs' })
  const renameChat = (id: string, title: string) =>
    clientRef.current?.send({ type: 'rename_chat', chatId: id, title })
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

  const browseFolder = (path: string) => clientRef.current?.send({ type: 'list_dirs', path })
  const chooseFolder = (path: string) => {
    clientRef.current?.send({ type: 'create_chat', cwd: path })
    dispatch({ kind: 'closeFolder' })
  }
  const cancelFolder = () => dispatch({ kind: 'closeFolder' })

  const decide = (decision: 'allow' | 'deny') => {
    if (!state.pending) return
    clientRef.current?.send({
      type: 'permission_response',
      requestId: state.pending.requestId,
      decision,
    })
    dispatch({ kind: 'clearPending' })
  }

  return (
    <div className="flex h-full">
      <Sidebar
        chats={state.chats}
        activeChatId={activeId}
        onSelect={selectChat}
        onNew={newChat}
        onRename={renameChat}
        onDelete={deleteChat}
      />
      <div className="flex h-full flex-1 flex-col">
        <header className="flex items-center justify-between border-b bg-white px-4 py-3">
          <span className="text-lg font-semibold">Claude Web Agent</span>
          {status === 'closed' && (
            <span className="rounded bg-yellow-100 px-2 py-1 text-xs text-yellow-800">
              การเชื่อมต่อหลุด กำลังเชื่อมต่อใหม่…
            </span>
          )}
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
        ) : (
          <div className="flex flex-1 items-center justify-center bg-gray-50 text-gray-500">
            <div className="text-center">
              <p className="text-base">ยังไม่มีแชทที่เลือก</p>
              <button
                className="mt-3 rounded-lg bg-blue-600 px-4 py-2 text-white"
                onClick={newChat}
              >
                + สร้างแชทใหม่
              </button>
            </div>
          </div>
        )}
      </div>
      {state.folder?.open && (
        <FolderPicker
          state={state.folder}
          onBrowse={browseFolder}
          onChoose={chooseFolder}
          onClose={cancelFolder}
        />
      )}
      {state.pending && <PermissionModal prompt={state.pending} onDecide={decide} />}
    </div>
  )
}
