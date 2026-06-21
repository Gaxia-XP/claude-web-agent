// server/compat/models.test.ts
import { describe, it, expect } from 'vitest'
import { openDb, createConnection } from '../store'
import { parseModelId, resolveConnectionByName, connectionToProviderConfig, listCompatModels } from './models'

describe('compat/models parseModelId', () => {
  it('parses "<conn>/<model>" as readonly', () => {
    expect(parseModelId('local/sonnet')).toEqual({ connName: 'local', policy: 'readonly', model: 'sonnet' })
  })
  it('parses "<conn>-auto/<model>" as auto', () => {
    expect(parseModelId('local-auto/sonnet')).toEqual({ connName: 'local', policy: 'auto', model: 'sonnet' })
  })
  it('keeps slashes inside the model segment (split on the FIRST slash only)', () => {
    expect(parseModelId('openrouter/anthropic/claude-3.5-sonnet')).toEqual({
      connName: 'openrouter', policy: 'readonly', model: 'anthropic/claude-3.5-sonnet',
    })
  })
  it('returns null for malformed ids', () => {
    expect(parseModelId('nomodel')).toBeNull()      // no slash
    expect(parseModelId('/sonnet')).toBeNull()       // empty conn
    expect(parseModelId('local/')).toBeNull()        // empty model
    expect(parseModelId('-auto/sonnet')).toBeNull()  // empty conn before -auto
  })
})

describe('compat/models resolve + enumerate', () => {
  it('resolves a connection by NAME and exposes its secret', () => {
    const db = openDb(':memory:')
    createConnection(db, { id: 'c2', type: 'anthropic-api', name: 'claude', apiKey: 'sk-x', defaultModel: 'claude-opus-4-8', now: 1 })
    const conn = resolveConnectionByName(db, 'claude')
    expect(conn?.id).toBe('c2')
    expect(conn?.apiKey).toBe('sk-x')
    expect(resolveConnectionByName(db, 'missing')).toBeUndefined()
  })
  it('builds a ProviderConfig with the requested model + secret', () => {
    const conn = { id: 'c2', type: 'anthropic-api', name: 'claude', apiKey: 'sk-x', defaultModel: 'd', createdAt: 1, updatedAt: 1 }
    expect(connectionToProviderConfig(conn, 'claude-opus-4-8')).toEqual({ type: 'anthropic-api', defaultModel: 'claude-opus-4-8', apiKey: 'sk-x' })
  })
  it('lists "<name>/<model>" for all, plus "-auto" only for local-agent', () => {
    const db = openDb(':memory:') // seeds the local-agent connection name="local" defaultModel="sonnet"
    createConnection(db, { id: 'c2', type: 'anthropic-api', name: 'claude', apiKey: 'sk', defaultModel: 'claude-opus-4-8', now: 1 })
    const ids = listCompatModels(db)
    expect(ids).toContain('local/sonnet')
    expect(ids).toContain('local-auto/sonnet')
    expect(ids).toContain('claude/claude-opus-4-8')
    expect(ids).not.toContain('claude-auto/claude-opus-4-8') // provider-API connections get no -auto variant
  })
})
