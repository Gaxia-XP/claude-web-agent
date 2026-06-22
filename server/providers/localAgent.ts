import { query } from '@anthropic-ai/claude-agent-sdk'
import type { Usage } from '../../shared/protocol'
import type { Provider, ProviderContext, TurnParams, TurnResult } from './types'
import { normalizeToolResult } from './normalize'

type QueryFn = typeof query

export class LocalAgentProvider implements Provider {
  readonly type = 'local-agent'

  constructor(private queryFn: QueryFn = query) {}

  async send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
    const self = this
    let sessionId = params.sdkSessionId
    let finalText = ''
    let usage: Usage | undefined

    async function* input() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: params.userText },
        parent_tool_use_id: null,
      }
    }

    const q = self.queryFn({
      // streaming input mode (จำเป็นสำหรับ canUseTool)
      prompt: input() as never,
      options: {
        cwd: params.cwd,
        model: params.model,
        includePartialMessages: true,
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        ...(sessionId ? { resume: sessionId } : {}),
        canUseTool: async (toolName: string, toolInput: unknown) => {
          return ctx.permission.resolve(toolName, toolInput)
        },
      } as never,
    })

    // #6a proactive interrupt: fire interrupt() the moment the signal aborts,
    // not just at the top of the loop. Guard so it only fires once.
    let interrupted = false
    const onAbort = () => {
      if (interrupted) return
      interrupted = true
      void (q as { interrupt?: () => Promise<void> }).interrupt?.()
    }
    if (ctx.signal.aborted) {
      onAbort()
    } else {
      ctx.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      for await (const msg of q as AsyncIterable<any>) {
        if (ctx.signal.aborted) {
          onAbort()
          break
        }
        switch (msg.type) {
          case 'system':
            if (msg.subtype === 'init' && typeof msg.session_id === 'string') sessionId = msg.session_id
            break
          case 'stream_event': {
            const ev = msg.event
            if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
              ctx.onDelta(ev.delta.text)
            }
            break
          }
          case 'assistant': {
            const content = msg.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block?.type === 'tool_use') {
                  ctx.onToolCall({ id: block.id, name: block.name, input: block.input })
                }
              }
            }
            break
          }
          case 'user': {
            const content = msg.message?.content
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block?.type === 'tool_result') {
                  ctx.onToolResult(block.tool_use_id, normalizeToolResult(block.content))
                }
              }
            }
            break
          }
          case 'result': {
            // The SDK marks API failures with is_error:true even though subtype stays 'success'
            // (e.g. {subtype:'success', is_error:true, api_error_status:529, result:'API Error: 529 ...'}).
            // Treat any non-success subtype OR an is_error result as a turn failure so the error text
            // never masquerades as the assistant's answer. We throw our own clean error rather than
            // relying on the SDK to throw on the next iteration (which it may stop doing).
            if (msg.subtype === 'success' && !msg.is_error) {
              if (typeof msg.result === 'string') finalText = msg.result
              if (msg.usage) {
                usage = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens }
              }
            } else {
              const detail = msg.is_error && typeof msg.result === 'string' ? msg.result : msg.subtype
              throw new Error(`local-agent turn failed: ${detail}`)
            }
            break
          }
        }
      }
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
    }

    return { text: finalText, usage, sdkSessionId: sessionId }
  }
}
