// server/compat/wire.test.ts
import { describe, it, expect } from 'vitest'
import { EventEmitter } from 'node:events'
import type { FastifyReply } from 'fastify'
import { parseCompatBody, openSseStream } from './wire'

// Minimal ServerResponse-like raw so openSseStream can be exercised without a real socket.
function fakeReply(): { reply: FastifyReply; raw: EventEmitter & { writableEnded: boolean; destroyed: boolean; writeCount: number } } {
  const raw = Object.assign(new EventEmitter(), {
    writableEnded: false, destroyed: false, writeCount: 0,
    writeHead(): void {},
    write(): boolean { raw.writeCount++; return true },
    end(): void { raw.writableEnded = true },
  })
  return { reply: { hijack(): void {}, raw } as unknown as FastifyReply, raw }
}

describe('compat/wire parseCompatBody', () => {
  it('parses a valid body (string content)', () => {
    expect(parseCompatBody({ model: 'local/sonnet', messages: [{ role: 'user', content: 'hi' }], stream: true }))
      .toEqual({ model: 'local/sonnet', messages: [{ role: 'user', content: 'hi' }], stream: true })
  })

  it('flattens an array-of-text-blocks content and drops non-text blocks', () => {
    const r = parseCompatBody({
      model: 'm',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }, { type: 'image', source: {} }] }],
    })
    expect(r?.messages[0].content).toBe('ab')
  })

  it('returns null for a system-only body (no user/assistant turn) — the empty-input guard', () => {
    expect(parseCompatBody({ model: 'm', messages: [{ role: 'system', content: 'sys' }] })).toBeNull()
  })

  it('keeps system messages when a user/assistant turn is also present', () => {
    const r = parseCompatBody({ model: 'm', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }] })
    expect(r?.messages.map((m) => m.role)).toEqual(['system', 'user'])
  })

  it('returns null for malformed bodies', () => {
    expect(parseCompatBody({ messages: [{ role: 'user', content: 'x' }] })).toBeNull() // no model
    expect(parseCompatBody({ model: '', messages: [{ role: 'user', content: 'x' }] })).toBeNull() // empty model
    expect(parseCompatBody({ model: 'm', messages: [] })).toBeNull() // empty messages
    expect(parseCompatBody({ model: 'm', messages: [{ role: 'tool', content: 'x' }] })).toBeNull() // bad role
    expect(parseCompatBody({ model: 'm', messages: [{ role: 'user' }] })).toBeNull() // no content
    expect(parseCompatBody(undefined)).toBeNull()
  })
})

describe('compat/wire openSseStream', () => {
  it('aborts the signal when the client connection closes (raw "close")', () => {
    const { reply, raw } = fakeReply()
    const sse = openSseStream(reply)
    expect(sse.signal.aborted).toBe(false)
    raw.emit('close')
    expect(sse.signal.aborted).toBe(true) // removing the on('close')->abort guard (fix D) fails this
  })

  it('abort() flips the signal; end() makes canWrite() false so write() becomes a no-op', () => {
    const { reply, raw } = fakeReply()
    const sse = openSseStream(reply)
    sse.write('a\n\n')
    expect(sse.canWrite()).toBe(true)
    sse.end()
    expect(raw.writableEnded).toBe(true)
    expect(sse.canWrite()).toBe(false)
    const before = raw.writeCount
    sse.write('b\n\n') // guarded by canWrite() -> no-op after end()
    expect(raw.writeCount).toBe(before)
    sse.abort()
    expect(sse.signal.aborted).toBe(true)
  })
})
