import { describe, it, expect } from 'vitest'
import {
  initialAppState,
  applyServer,
  appendUser,
  setActiveChat,
  clearPending,
  closeFolder,
  type AppState,
} from './appState'
import type { ChatMeta, StoredMessage } from '@shared/protocol'

const meta = (id: string, over: Partial<ChatMeta> = {}): ChatMeta => ({
  id,
  title: 'New chat',
  connectionId: 'local',
  model: 'sonnet',
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

describe('appState', () => {
  it('appendUser pushes a user msg into views[chatId] and sets that view streaming', () => {
    const s = appendUser(initialAppState, 'c1', 'hi')
    expect(s.views.c1.messages).toEqual([{ role: 'user', text: 'hi' }])
    expect(s.views.c1.streaming).toBe(true)
  })

  it('assistant_delta accumulates into the chat view and does NOT bleed into another chatId view', () => {
    let s: AppState = appendUser(initialAppState, 'c1', 'hi')
    s = appendUser(s, 'c2', 'yo')
    s = applyServer(s, { type: 'assistant_delta', chatId: 'c1', text: 'Hel' })
    s = applyServer(s, { type: 'assistant_delta', chatId: 'c1', text: 'lo' })
    expect(s.views.c1.messages[1]).toEqual({ role: 'assistant', text: 'Hello', tools: [] })
    // c2 view untouched: only its user message, no assistant bubble
    expect(s.views.c2.messages).toEqual([{ role: 'user', text: 'yo' }])
  })

  it('tool_call appends to the last assistant msg tools (creating one if needed)', () => {
    let s: AppState = appendUser(initialAppState, 'c1', 'hi')
    s = applyServer(s, { type: 'assistant_delta', chatId: 'c1', text: 'x' })
    s = applyServer(s, {
      type: 'tool_call',
      chatId: 'c1',
      id: 't1',
      name: 'Read',
      input: { file_path: '/a' },
    })
    const last = s.views.c1.messages[1]
    expect(last.role).toBe('assistant')
    if (last.role === 'assistant') {
      expect(last.tools).toEqual([{ id: 't1', name: 'Read', input: { file_path: '/a' } }])
    }
  })

  it('tool_result is ignored for render (view unchanged)', () => {
    let s: AppState = appendUser(initialAppState, 'c1', 'hi')
    s = applyServer(s, { type: 'assistant_delta', chatId: 'c1', text: 'x' })
    const before = s.views.c1
    s = applyServer(s, { type: 'tool_result', chatId: 'c1', id: 't1', result: 'ok' })
    expect(s.views.c1).toBe(before)
  })

  it('permission_request sets state.pending with chatId', () => {
    let s: AppState = appendUser(initialAppState, 'c1', 'hi')
    s = applyServer(s, {
      type: 'permission_request',
      chatId: 'c1',
      requestId: 'r1',
      name: 'Write',
      input: {},
    })
    expect(s.pending).toEqual({ chatId: 'c1', requestId: 'r1', name: 'Write', input: {} })
  })

  it('turn_done sets that view streaming false', () => {
    let s: AppState = appendUser(initialAppState, 'c1', 'hi')
    s = applyServer(s, { type: 'turn_done', chatId: 'c1' })
    expect(s.views.c1.streaming).toBe(false)
  })

  it('error pushes a { role:"error" } msg into that view', () => {
    let s: AppState = appendUser(initialAppState, 'c1', 'hi')
    s = applyServer(s, { type: 'error', chatId: 'c1', message: 'boom' })
    const errors = s.views.c1.messages.filter((m) => m.role === 'error')
    expect(errors).toEqual([{ role: 'error', text: 'boom' }])
    // user message left intact
    expect(s.views.c1.messages[0]).toEqual({ role: 'user', text: 'hi' })
  })

  it('error without chatId is dropped (no view to attach it to)', () => {
    const s = applyServer(initialAppState, { type: 'error', message: 'global boom' })
    // optional chatId on the error variant: nothing to route to, state unchanged
    expect(s).toBe(initialAppState)
  })

  it('error does not mutate a previous turn assistant message', () => {
    let s: AppState = appendUser(initialAppState, 'c1', 'q1')
    s = applyServer(s, { type: 'assistant_delta', chatId: 'c1', text: 'answer1' })
    s = applyServer(s, { type: 'turn_done', chatId: 'c1' })
    s = appendUser(s, 'c1', 'q2')
    s = applyServer(s, { type: 'error', chatId: 'c1', message: 'boom' })
    expect(s.views.c1.messages[1]).toEqual({ role: 'assistant', text: 'answer1', tools: [] })
    const msgs = s.views.c1.messages
    expect(msgs[msgs.length - 1]).toEqual({ role: 'error', text: 'boom' })
  })

  it('chat_list sets chats', () => {
    const s = applyServer(initialAppState, {
      type: 'chat_list',
      chats: [meta('c1', { title: 'A' }), meta('c2', { title: 'B' })],
    })
    expect(s.chats.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('chat_created adds chat, sets activeChatId, inits an empty view', () => {
    const s = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1') })
    expect(s.chats.map((c) => c.id)).toEqual(['c1'])
    expect(s.activeChatId).toBe('c1')
    expect(s.views.c1).toEqual({ messages: [], streaming: false })
  })

  it('chat_renamed updates the title', () => {
    let s: AppState = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1', { title: 'Old' }) })
    s = applyServer(s, { type: 'chat_renamed', chatId: 'c1', title: 'New title' })
    expect(s.chats[0].title).toBe('New title')
  })

  it('chat_deleted removes chat + view and clears activeChatId if it was active', () => {
    let s: AppState = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1') })
    s = applyServer(s, { type: 'chat_deleted', chatId: 'c1' })
    expect(s.chats).toEqual([])
    expect(s.views.c1).toBeUndefined()
    expect(s.activeChatId).toBeUndefined()
  })

  it('chat_deleted of a non-active chat leaves activeChatId intact', () => {
    let s: AppState = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1') })
    s = applyServer(s, { type: 'chat_created', chat: meta('c2') }) // c2 active
    s = applyServer(s, { type: 'chat_deleted', chatId: 'c1' })
    expect(s.chats.map((c) => c.id)).toEqual(['c2'])
    expect(s.activeChatId).toBe('c2')
  })

  it('chat_history builds UiMessage[] from StoredMessage[] (user text, assistant text+tools)', () => {
    const messages: StoredMessage[] = [
      {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        createdAt: 1,
      },
      {
        id: 'm2',
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hi ' },
          { type: 'text', text: 'there' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/a' } },
          { type: 'tool_result', id: 't1', result: 'ok' },
        ],
        createdAt: 2,
      },
    ]
    const s = applyServer(initialAppState, { type: 'chat_history', chatId: 'c1', messages })
    expect(s.views.c1.streaming).toBe(false)
    expect(s.views.c1.messages).toEqual([
      { role: 'user', text: 'hello' },
      {
        role: 'assistant',
        text: 'Hi there',
        tools: [{ id: 't1', name: 'Read', input: { file_path: '/a' } }],
      },
    ])
  })

  it('dir_list sets state.folder { open:true, path, parent, entries }', () => {
    const s = applyServer(initialAppState, {
      type: 'dir_list',
      path: '/home/me',
      parent: '/home',
      entries: [{ name: 'proj', path: '/home/me/proj' }],
    })
    expect(s.folder).toEqual({
      open: true,
      path: '/home/me',
      parent: '/home',
      entries: [{ name: 'proj', path: '/home/me/proj' }],
    })
  })

  it('setActiveChat sets the active id', () => {
    let s: AppState = applyServer(initialAppState, { type: 'chat_created', chat: meta('c1') })
    s = applyServer(s, { type: 'chat_created', chat: meta('c2') })
    s = setActiveChat(s, 'c1')
    expect(s.activeChatId).toBe('c1')
  })

  it('clearPending removes the pending prompt', () => {
    let s: AppState = appendUser(initialAppState, 'c1', 'hi')
    s = applyServer(s, {
      type: 'permission_request',
      chatId: 'c1',
      requestId: 'r1',
      name: 'Write',
      input: {},
    })
    s = clearPending(s)
    expect(s.pending).toBeUndefined()
  })

  it('closeFolder removes the folder state', () => {
    let s: AppState = applyServer(initialAppState, {
      type: 'dir_list',
      path: '/home',
      entries: [],
    })
    s = closeFolder(s)
    expect(s.folder).toBeUndefined()
  })

  // ── regression: fix #3 ────────────────────────────────────────────────────
  it('#3a: error with no chatId while folder is open sets folder.error (keeps picker open)', () => {
    let s: AppState = applyServer(initialAppState, {
      type: 'dir_list',
      path: '/bad',
      entries: [],
    })
    expect(s.folder?.open).toBe(true)

    s = applyServer(s, { type: 'error', message: 'Permission denied' })
    expect(s.folder?.open).toBe(true)
    expect(s.folder?.error).toBe('Permission denied')
  })

  it('#3b: subsequent dir_list clears folder.error', () => {
    let s: AppState = applyServer(initialAppState, {
      type: 'dir_list',
      path: '/bad',
      entries: [],
    })
    s = applyServer(s, { type: 'error', message: 'Permission denied' })
    expect(s.folder?.error).toBe('Permission denied')

    // A successful dir_list should clear the error
    s = applyServer(s, {
      type: 'dir_list',
      path: '/good',
      parent: '/',
      entries: [{ name: 'src', path: '/good/src' }],
    })
    expect(s.folder?.error).toBeUndefined()
    expect(s.folder?.path).toBe('/good')
  })

  it('#3c: error with no chatId and folder NOT open leaves state unchanged', () => {
    const s = applyServer(initialAppState, { type: 'error', message: 'global boom' })
    expect(s).toBe(initialAppState)
  })

  // ── B2 regression: chat_history must NOT clobber a live streaming view ────────
  it('(B2a) chat_history for a streaming view is ignored (live stream preserved)', () => {
    // Set up a view that is mid-stream
    let s: AppState = appendUser(initialAppState, 'c1', 'hello')
    // appendUser sets streaming:true
    expect(s.views.c1.streaming).toBe(true)
    s = applyServer(s, { type: 'assistant_delta', chatId: 'c1', text: 'partial...' })
    expect(s.views.c1.streaming).toBe(true)
    expect((s.views.c1.messages[1] as { role: 'assistant'; text: string; tools: unknown[] }).text).toBe('partial...')

    // Save reference to the live view
    const liveView = s.views.c1

    // Now apply a chat_history with DIFFERENT committed messages (simulating re-subscribe)
    const committedMessages: StoredMessage[] = [
      {
        id: 'm-old',
        role: 'user',
        content: [{ type: 'text', text: 'old message only' }],
        createdAt: 1,
      },
    ]
    s = applyServer(s, { type: 'chat_history', chatId: 'c1', messages: committedMessages })

    // The live view must be UNCHANGED — chat_history was ignored
    expect(s.views.c1).toBe(liveView)
    expect(s.views.c1.streaming).toBe(true)
    expect((s.views.c1.messages[1] as { role: 'assistant'; text: string; tools: unknown[] }).text).toBe('partial...')
  })

  it('(B2b) chat_history for a non-streaming view still populates it (initial load still works)', () => {
    // No view yet (or streaming:false after a completed turn)
    let s: AppState = initialAppState

    const messages: StoredMessage[] = [
      {
        id: 'm1',
        role: 'user',
        content: [{ type: 'text', text: 'loaded message' }],
        createdAt: 1,
      },
    ]
    s = applyServer(s, { type: 'chat_history', chatId: 'c1', messages })
    expect(s.views.c1.streaming).toBe(false)
    expect(s.views.c1.messages).toEqual([{ role: 'user', text: 'loaded message' }])
  })

  it('immutability: a delta into c1 returns a new views object and does not mutate the input', () => {
    const prev: AppState = appendUser(initialAppState, 'c1', 'hi')
    const next = applyServer(prev, { type: 'assistant_delta', chatId: 'c1', text: 'yo' })
    expect(next.views).not.toBe(prev.views)
    // input view's messages array length unchanged (only the user msg)
    expect(prev.views.c1.messages).toHaveLength(1)
    expect(next.views.c1.messages).toHaveLength(2)
  })
})
