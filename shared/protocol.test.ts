import { describe, it, expect } from 'vitest'
import { parseClientMsg } from './protocol'

describe('parseClientMsg', () => {
  it('parses create_chat with all optional fields', () => {
    const m = parseClientMsg(
      JSON.stringify({ type: 'create_chat', title: 'My chat', model: 'sonnet', cwd: '/home/me' }),
    )
    expect(m).toEqual({ type: 'create_chat', title: 'My chat', model: 'sonnet', cwd: '/home/me' })
  })

  it('parses create_chat with no optional fields', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'create_chat' }))
    expect(m).toEqual({ type: 'create_chat' })
  })

  it('parses subscribe', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'subscribe', chatId: 'c1' }))
    expect(m).toEqual({ type: 'subscribe', chatId: 'c1' })
  })

  it('parses unsubscribe', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'unsubscribe', chatId: 'c1' }))
    expect(m).toEqual({ type: 'unsubscribe', chatId: 'c1' })
  })

  it('parses interrupt with chatId', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'interrupt', chatId: 'c1' }))
    expect(m).toEqual({ type: 'interrupt', chatId: 'c1' })
  })

  it('parses rename_chat', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'rename_chat', chatId: 'c1', title: 'New' }))
    expect(m).toEqual({ type: 'rename_chat', chatId: 'c1', title: 'New' })
  })

  it('parses delete_chat', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'delete_chat', chatId: 'c1' }))
    expect(m).toEqual({ type: 'delete_chat', chatId: 'c1' })
  })

  it('returns null for subscribe missing chatId', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'subscribe' }))).toBeNull()
  })

  it('returns null for subscribe with non-string chatId', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'subscribe', chatId: 7 }))).toBeNull()
  })

  it('returns null for interrupt missing chatId', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'interrupt' }))).toBeNull()
  })

  it('returns null for rename_chat missing title', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'rename_chat', chatId: 'c1' }))).toBeNull()
  })

  it('parses user_message with chatId and text', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'user_message', chatId: 'c1', text: 'hi' }))
    expect(m).toEqual({ type: 'user_message', chatId: 'c1', text: 'hi' })
  })

  it('returns null for user_message missing chatId', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'user_message', text: 'hi' }))).toBeNull()
  })

  it('returns null for user_message missing text', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'user_message', chatId: 'c1' }))).toBeNull()
  })

  it('parses permission_response allow', () => {
    const m = parseClientMsg(
      JSON.stringify({ type: 'permission_response', requestId: 'r1', decision: 'allow' }),
    )
    expect(m).toEqual({ type: 'permission_response', requestId: 'r1', decision: 'allow' })
  })

  it('parses permission_response deny', () => {
    const m = parseClientMsg(
      JSON.stringify({ type: 'permission_response', requestId: 'r1', decision: 'deny' }),
    )
    expect(m).toEqual({ type: 'permission_response', requestId: 'r1', decision: 'deny' })
  })

  it('returns null for permission_response with bad decision', () => {
    expect(
      parseClientMsg(JSON.stringify({ type: 'permission_response', requestId: 'r1', decision: 'maybe' })),
    ).toBeNull()
  })

  it('parses list_dirs with path', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'list_dirs', path: '/home/me' }))
    expect(m).toEqual({ type: 'list_dirs', path: '/home/me' })
  })

  it('parses list_dirs without path', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'list_dirs' }))
    expect(m).toEqual({ type: 'list_dirs' })
  })

  it('returns null for unknown type', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'nope' }))).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseClientMsg('{not json')).toBeNull()
  })
})

describe('protocol v3 — connections', () => {
  it('parses create_chat with connectionId + model + cwd', () => {
    const m = parseClientMsg(
      JSON.stringify({ type: 'create_chat', connectionId: 'c1', model: 'claude-opus-4-8', cwd: 'C:/x' }),
    )
    expect(m).toEqual({ type: 'create_chat', connectionId: 'c1', model: 'claude-opus-4-8', cwd: 'C:/x' })
  })

  it('parses create_chat without connectionId (omitted, not null)', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'create_chat' }))
    expect(m).toEqual({ type: 'create_chat' })
  })

  it('parses create_connection', () => {
    const m = parseClientMsg(
      JSON.stringify({
        type: 'create_connection',
        name: 'My Anthropic',
        providerType: 'anthropic-api',
        apiKey: 'sk-x',
        defaultModel: 'claude-opus-4-8',
      }),
    )
    expect(m).toEqual({
      type: 'create_connection',
      name: 'My Anthropic',
      providerType: 'anthropic-api',
      apiKey: 'sk-x',
      defaultModel: 'claude-opus-4-8',
    })
  })

  it('rejects create_connection missing required fields', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'create_connection', name: 'x' }))).toBeNull()
  })

  it('parses update_connection with only id + apiKey', () => {
    const m = parseClientMsg(JSON.stringify({ type: 'update_connection', id: 'c1', apiKey: 'sk-new' }))
    expect(m).toEqual({ type: 'update_connection', id: 'c1', apiKey: 'sk-new' })
  })

  it('parses delete_connection', () => {
    expect(parseClientMsg(JSON.stringify({ type: 'delete_connection', id: 'c1' }))).toEqual({
      type: 'delete_connection',
      id: 'c1',
    })
  })
})
