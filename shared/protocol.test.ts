import { describe, it, expect } from 'vitest'
import { parseClientMsg } from './protocol'

describe('parseClientMsg', () => {
  it('parses a valid user_message', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'user_message', text: 'hi' }))
    expect(m).toEqual({ type: 'user_message', text: 'hi' })
  })

  it('parses a permission_response', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'permission_response', requestId: 'r1', decision: 'allow' }))
    expect(m).toEqual({ type: 'permission_response', requestId: 'r1', decision: 'allow' })
  })

  it('returns null for unknown type', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'nope' }))).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseClientMsg('{not json')).toBeNull()
  })

  it('parses an interrupt message', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'interrupt' }))
    expect(m).toEqual({ type: 'interrupt' })
  })
})
