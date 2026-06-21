import type { FastifyReply } from 'fastify'
import type { CompatMessage } from './turn'

// Shared request-body parse for /v1/chat/completions + /v1/messages. `content` may be a string or an
// array of text blocks (Anthropic-style) -> flattened to text. Returns null (the caller maps to 400)
// on a malformed body OR a body that carries NO user/assistant turn after dropping system messages.
// That last guard is the empty-input fix: a system-only body would otherwise reach the provider with
// empty input (the Anthropic Messages API 400s on empty content; local-agent gets a blank prompt).
export function parseCompatBody(
  body: unknown,
): { model: string; messages: CompatMessage[]; stream: boolean } | null {
  const b = (body ?? {}) as { model?: unknown; messages?: unknown; stream?: unknown }
  if (typeof b.model !== 'string' || b.model === '') return null
  if (!Array.isArray(b.messages) || b.messages.length === 0) return null
  const messages: CompatMessage[] = []
  for (const m of b.messages) {
    const role = (m as { role?: unknown }).role
    const content = (m as { content?: unknown }).content
    let text: string | null = null
    if (typeof content === 'string') text = content
    else if (Array.isArray(content)) {
      text = content
        .filter((x) => (x as { type?: unknown }).type === 'text')
        .map((x) => (x as { text?: unknown }).text)
        .filter((t): t is string => typeof t === 'string')
        .join('')
    }
    if ((role === 'system' || role === 'user' || role === 'assistant') && text !== null) {
      messages.push({ role, content: text })
    } else return null
  }
  if (!messages.some((m) => m.role === 'user' || m.role === 'assistant')) return null
  return { model: b.model, messages, stream: b.stream === true }
}

export type SseStream = {
  write: (frame: string) => void
  canWrite: () => boolean
  signal: AbortSignal
  abort: () => void
  end: () => void
}

// Hijack a Fastify reply into a raw SSE stream with the M4 crash-guard pattern. Both compat stream
// branches (OpenAI `data:` frames, Anthropic `event:`/`data:` frames) share this scaffolding so the
// load-bearing guards stay in ONE place: raw.on('error') absorbs post-canWrite EPIPE/write-after-
// destroy races; raw.on('close') aborts the provider run when the client disconnects; the caller
// MUST also call abort() on return (finally) so a timed-out provider run never lingers detached.
// The caller formats its own frames and writes them via write().
export function openSseStream(reply: FastifyReply): SseStream {
  const ac = new AbortController()
  reply.hijack()
  const raw = reply.raw
  raw.on('error', () => {}) // load-bearing: absorbs the canWrite()-vs-flush TOCTOU race (do not remove)
  raw.on('close', () => ac.abort()) // client disconnect -> abort the in-flight provider turn
  const canWrite = (): boolean => !raw.writableEnded && !raw.destroyed
  raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  return {
    write: (frame) => { if (canWrite()) raw.write(frame) },
    canWrite,
    signal: ac.signal,
    abort: () => ac.abort(),
    end: () => { if (canWrite()) raw.end() },
  }
}
