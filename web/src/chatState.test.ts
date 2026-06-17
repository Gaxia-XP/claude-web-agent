import { describe, it, expect } from 'vitest'
import { initialState, applyServer, appendUser, type ChatState } from './chatState'

describe('chatState', () => {
  it('appendUser adds a user message and starts streaming', () => {
    const s = appendUser(initialState, 'hi')
    expect(s.messages).toEqual([{ role: 'user', text: 'hi' }])
    expect(s.streaming).toBe(true)
  })

  it('assistant_delta accumulates into a single assistant message', () => {
    let s: ChatState = appendUser(initialState, 'hi')
    s = applyServer(s, { type: 'assistant_delta', text: 'Hel' })
    s = applyServer(s, { type: 'assistant_delta', text: 'lo' })
    expect(s.messages[1]).toEqual({ role: 'assistant', text: 'Hello', tools: [] })
  })

  it('tool_call attaches to the current assistant message', () => {
    let s: ChatState = appendUser(initialState, 'hi')
    s = applyServer(s, { type: 'assistant_delta', text: 'x' })
    s = applyServer(s, { type: 'tool_call', id: 't1', name: 'Read', input: { file_path: '/a' } })
    const last = s.messages[1]
    expect(last.role).toBe('assistant')
    if (last.role === 'assistant') expect(last.tools).toEqual([{ id: 't1', name: 'Read', input: { file_path: '/a' } }])
  })

  it('permission_request sets pending; response is cleared by caller via clearPending path', () => {
    let s: ChatState = appendUser(initialState, 'hi')
    s = applyServer(s, { type: 'permission_request', requestId: 'r1', name: 'Write', input: {} })
    expect(s.pending).toEqual({ requestId: 'r1', name: 'Write', input: {} })
  })

  it('turn_done stops streaming', () => {
    let s: ChatState = appendUser(initialState, 'hi')
    s = applyServer(s, { type: 'turn_done' })
    expect(s.streaming).toBe(false)
  })
})
