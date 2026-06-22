// server/compat/turn.test.ts
import { describe, it, expect } from 'vitest'
import { openDb, createConnection, deleteConnection } from '../store'
import { FakeProvider } from '../providers/fake'
import { makeProvider } from '../providers/index'
import { compatMessagesToTurnParams, renderLocalAgentPrompt, resolveCompatTurn, executeCompatTurn, CompatError } from './turn'

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
  it('throws CompatError 404 for a malformed model id (slash present but unparseable)', () => {
    // NOTE: a bare 'nope' (no slash) is now a valid bare-name input -> default local-agent.
    // A malformed id is one that DOES contain a slash yet fails to parse, e.g. '/sonnet'.
    expect(() => resolveCompatTurn(deps, '/sonnet')).toThrow(CompatError)
    try { resolveCompatTurn(deps, '/sonnet') } catch (e) { expect((e as CompatError).status).toBe(404) }
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

  // Bare model ids (no '/') let third-party clients (LMSA, OpenAI SDK) that send just a model
  // name like 'sonnet' work without knowing the '<conn>/<model>' convention. They route to the
  // default local-agent connection with readonly policy; the bare string is the model.
  it('resolves a BARE model id (no slash) to the default local-agent connection, readonly', () => {
    const r = resolveCompatTurn(deps, 'sonnet')
    expect(r.provider.type).toBe('local-agent')
    expect(r.policy).toBe('readonly')
    expect(r.model).toBe('sonnet')
  })
  it('passes an arbitrary bare model string through unchanged (e.g. claude-opus-4-7)', () => {
    const r = resolveCompatTurn(deps, 'claude-opus-4-7')
    expect(r.model).toBe('claude-opus-4-7')
    expect(r.provider.type).toBe('local-agent')
  })
  it('still 404s a malformed id that DOES contain a slash (e.g. "local/")', () => {
    expect.assertions(1)
    try { resolveCompatTurn(deps, 'local/') } catch (e) { expect((e as CompatError).status).toBe(404) }
  })
  it('404s a bare name when no local-agent connection exists', () => {
    expect.assertions(1)
    const db = openDb(':memory:')
    deleteConnection(db, 'local')
    createConnection(db, { id: 'c2', type: 'anthropic-api', name: 'claude', apiKey: 'sk', defaultModel: 'd', now: 1 })
    try { resolveCompatTurn({ db, makeProvider }, 'sonnet') } catch (e) { expect((e as CompatError).status).toBe(404) }
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

  it('(A) folds the multi-turn transcript into userText for a local-agent provider (no context loss)', async () => {
    let captured = ''
    const localCapture = { type: 'local-agent', async send(params: { userText: string }) { captured = params.userText; return { text: 'ok' } } }
    await executeCompatTurn({
      provider: localCapture as never, policy: 'auto', model: 'm',
      messages: [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }], signal: ac(),
    })
    expect(captured).toContain('Q1') // was: only 'Q2' reached local-agent (all prior context lost)
    expect(captured).toContain('A1')
    expect(captured).toContain('Q2')
  })

  it('(A) single-turn local-agent gets the clean prompt (no preamble pollution)', async () => {
    let captured = ''
    const localCapture = { type: 'local-agent', async send(params: { userText: string }) { captured = params.userText; return { text: 'ok' } } }
    await executeCompatTurn({ provider: localCapture as never, policy: 'auto', model: 'm', messages: [{ role: 'user', content: 'just this' }], signal: ac() })
    expect(captured).toBe('just this')
  })

  it('(A) a non-local-agent provider is unchanged — userText stays the LAST user message (history carries the rest)', async () => {
    let captured = ''
    const apiCapture = { type: 'openai-compatible', async send(params: { userText: string }) { captured = params.userText; return { text: 'ok' } } }
    await executeCompatTurn({
      provider: apiCapture as never, policy: 'auto', model: 'm',
      messages: [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }], signal: ac(),
    })
    expect(captured).toBe('Q2')
  })
})

describe('compat/turn renderLocalAgentPrompt', () => {
  it('single user message -> clean prompt, no preamble', () => {
    expect(renderLocalAgentPrompt([{ role: 'user', content: 'hi' }])).toBe('hi')
  })
  it('multi-turn -> a transcript carrying every prior turn', () => {
    const p = renderLocalAgentPrompt([{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }])
    expect(p).toContain('User: Q1')
    expect(p).toContain('Assistant: A1')
    expect(p).toContain('User: Q2')
  })
  it('drops system messages from the rendered transcript', () => {
    const p = renderLocalAgentPrompt([{ role: 'system', content: 'SECRET' }, { role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }, { role: 'user', content: 'Q2' }])
    expect(p).not.toContain('SECRET')
  })
})
