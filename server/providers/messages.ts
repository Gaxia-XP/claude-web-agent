import type { StoredMessage } from '../../shared/protocol'

export type ChatMessage = { role: 'user' | 'assistant'; content: string }

function extractText(m: StoredMessage): string {
  let text = ''
  for (const b of m.content) {
    if (b.type === 'text') text += b.text
  }
  return text
}

// Build a clean, alternating-friendly message list from persisted history.
// - keep only text content (tool_use/tool_result/error blocks are dropped — stateless
//   providers have no tools, and error rows must not be replayed as assistant turns)
// - drop messages that have no text after extraction
// - merge consecutive same-role messages — these arise when an intervening row drops to empty
//   after text extraction (e.g. an error-only or tool-only assistant turn). Some
//   OpenAI-compatible servers reject non-alternating roles; Anthropic tolerates it but merging
//   is harmless. (ChatRuntime separately guarantees the LAST row is the current user question.)
export function historyToChatMessages(history: StoredMessage[]): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const m of history) {
    const text = extractText(m)
    if (text === '') continue
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content += '\n' + text
    } else {
      out.push({ role: m.role, content: text })
    }
  }
  return out
}
