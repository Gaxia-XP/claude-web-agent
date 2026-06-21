// server/compat/turn.test.ts
import { describe, it, expect } from 'vitest'
import { openDb, createConnection } from '../store'
import { FakeProvider } from '../providers/fake'
import { makeProvider } from '../providers/index'
import { compatMessagesToTurnParams, resolveCompatTurn, executeCompatTurn, CompatError } from './turn'

const ac = (): AbortSignal => new AbortController().signal

describe('compat/turn compatMessagesToTurnParams', () => {
  it('uses the LAST user message as userText and builds history from user/assistant only', () => {
    const p = compatMessagesToTurnParams(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }],
      'sonnet',
    )
    expect(p.userText).toBe('Q2')
    expect(p.model).toBe('sonnet')
    expect(p.history?.map((m) => m.role)).toEqual(['user', 'assistant', 'user']) // system dropped
    expect(p.history?.[0].content).toEqual([{ type: 'text', text: 'Q1' }])
  })
})

describe('compat/turn resolveCompatTurn', () => {
  const deps = { db: openDb(':memory:'), makeProvider }
  it('throws CompatError 404 for a malformed model id', () => {
    expect(() => resolveCompatTurn(deps, 'nope')).toThrow(CompatError)
    try { resolveCompatTurn(deps, 'nope') } catch (e) { expect((e as CompatError).status).toBe(404) }
  })
  it('throws CompatError 404 for an unknown connection name', () => {
    expect.assertions(1) // fail loudly if resolveCompatTurn ever stops throwing
    try { resolveCompatTurn(deps, 'ghost/x') } catch (e) { expect((e as CompatError).status).toBe(404) }
  })
  it('throws CompatError 400 when the provider cannot be built (anthropic-api with no key)', () => {
    expect.assertions(1)
    const db = openDb(':memory:')
    createConnection(db, { id: 'c2', type: 'anthropic-api', name: 'claude', defaultModel: 'd', now: 1 }) // no apiKey
    try { resolveCompatTurn({ db, makeProvider }, 'claude/claude-opus-4-8') } catch (e) {
      expect((e as CompatError).status).toBe(400)
    }
  })
  it('resolves provider + policy for a valid local-auto id', () => {
    const r = resolveCompatTurn(deps, 'local-auto/sonnet') // seeded local-agent connection
    expect(r.policy).toBe('auto')
    expect(r.model).toBe('sonnet')
    expect(r.provider.type).toBe('local-agent')
  })
})

describe('compat/turn executeCompatTurn', () => {
  it('runs the real runTurn via FakeProvider, returns final text + usage, streams deltas', async () => {
    const deltas: string[] = []
    const out = await executeCompatTurn({
      provider: new FakeProvider(), policy: 'auto', model: 'm',
      messages: [{ role: 'user', content: 'world' }], signal: ac(), onDelta: (t) => deltas.push(t),
    })
    expect(out.text).toBe('Hello world')         // FakeProvider returns 'Hello ' + userText
    expect(out.usage).toEqual({ outputTokens: 3 })
    expect(out.error).toBeUndefined()
    expect(deltas.join('')).toBe('Hello world')   // assistant_delta forwarded; tool events dropped
  })
  it('surfaces a provider error as { error } (runTurn never throws)', async () => {
    const boom = { type: 'boom', async send() { throw new Error('upstream down') } }
    const out = await executeCompatTurn({
      provider: boom as never, policy: 'readonly', model: 'm',
      messages: [{ role: 'user', content: 'x' }], signal: ac(),
    })
    expect(out.error).toMatch(/upstream down/)
    expect(out.text).toBe('')
  })
})
