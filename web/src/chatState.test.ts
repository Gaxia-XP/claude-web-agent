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

  it('ensureAssistant reuse branch returns a new array reference (immutability)', () => {
    // Build a state that already has a trailing assistant message
    let prev: ChatState = appendUser(initialState, 'hi')
    prev = applyServer(prev, { type: 'assistant_delta', text: 'Hello' })
    // Apply another delta — hits the reuse branch
    const next = applyServer(prev, { type: 'assistant_delta', text: ' world' })
    // The returned messages array must be a different reference
    expect(next.messages).not.toBe(prev.messages)
    // The input state must NOT have been mutated
    const prevAssistant = prev.messages[prev.messages.length - 1]
    expect(prevAssistant.role).toBe('assistant')
    if (prevAssistant.role === 'assistant') {
      expect(prevAssistant.text).toBe('Hello')
    }
    // And the new state reflects the concatenation
    const nextAssistant = next.messages[next.messages.length - 1]
    if (nextAssistant.role === 'assistant') {
      expect(nextAssistant.text).toBe('Hello world')
    }
  })

  it('delta → tool_call → delta produces exactly one assistant message with concatenated text', () => {
    let s: ChatState = appendUser(initialState, 'hi')
    s = applyServer(s, { type: 'assistant_delta', text: 'Thinking' })
    s = applyServer(s, { type: 'tool_call', id: 't1', name: 'Read', input: { file_path: '/x' } })
    s = applyServer(s, { type: 'assistant_delta', text: '...' })
    // Exactly one assistant message (no second bubble)
    const assistantMessages = s.messages.filter(m => m.role === 'assistant')
    expect(assistantMessages).toHaveLength(1)
    const asst = assistantMessages[0]
    if (asst.role === 'assistant') {
      expect(asst.text).toBe('Thinking...')
      expect(asst.tools).toEqual([{ id: 't1', name: 'Read', input: { file_path: '/x' } }])
    }
  })

  it('error before any assistant token is shown as its own message (not dropped)', () => {
    let s: ChatState = appendUser(initialState, 'hi') // messages: [user]
    s = applyServer(s, { type: 'error', message: 'auth failed' })
    const errors = s.messages.filter(m => m.role === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toEqual({ role: 'error', text: 'auth failed' })
    // user message left intact
    expect(s.messages[0]).toEqual({ role: 'user', text: 'hi' })
  })

  it('error does not attach to or mutate a previous turn\'s assistant message', () => {
    let s: ChatState = appendUser(initialState, 'q1')
    s = applyServer(s, { type: 'assistant_delta', text: 'answer1' })
    s = applyServer(s, { type: 'turn_done' })
    // second turn errors before any token
    s = appendUser(s, 'q2')
    s = applyServer(s, { type: 'error', message: 'boom' })
    // previous assistant answer is untouched (no '[error]' appended to it)
    expect(s.messages[1]).toEqual({ role: 'assistant', text: 'answer1', tools: [] })
    // a dedicated error message exists at the end
    expect(s.messages[s.messages.length - 1]).toEqual({ role: 'error', text: 'boom' })
  })
})
