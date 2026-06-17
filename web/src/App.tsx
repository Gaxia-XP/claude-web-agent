import { useEffect, useMemo, useReducer, useRef } from 'react'
import type { ServerMsg } from '@shared/protocol'
import { applyServer, appendUser, clearPending, initialState, type ChatState } from './chatState'
import { createWsClient } from './ws'
import { Message } from './components/Message'
import { Composer } from './components/Composer'
import { PermissionModal } from './components/PermissionModal'

type Action = { kind: 'server'; msg: ServerMsg } | { kind: 'user'; text: string } | { kind: 'clearPending' }

function reducer(state: ChatState, action: Action): ChatState {
  switch (action.kind) {
    case 'server':
      return applyServer(state, action.msg)
    case 'user':
      return appendUser(state, action.text)
    case 'clearPending':
      return clearPending(state)
  }
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState)
  const clientRef = useRef<ReturnType<typeof createWsClient> | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const client = createWsClient((msg) => dispatch({ kind: 'server', msg }))
    clientRef.current = client
    return () => client.close()
  }, [])

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [state.messages])

  const send = (text: string) => {
    dispatch({ kind: 'user', text })
    clientRef.current?.send({ type: 'user_message', text })
  }
  const stop = () => clientRef.current?.send({ type: 'interrupt' })
  const decide = (decision: 'allow' | 'deny') => {
    if (!state.pending) return
    clientRef.current?.send({ type: 'permission_response', requestId: state.pending.requestId, decision })
    dispatch({ kind: 'clearPending' })
  }

  const header = useMemo(() => 'Claude Web Agent', [])

  return (
    <div className="flex h-full flex-col">
      <header className="border-b bg-white px-4 py-3 text-lg font-semibold">{header}</header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto bg-gray-50">
        {state.messages.map((m, i) => (
          <Message key={i} msg={m} />
        ))}
      </div>
      <Composer disabled={state.streaming} onSend={send} onStop={stop} />
      {state.pending && <PermissionModal prompt={state.pending} onDecide={decide} />}
    </div>
  )
}
