import { describe, it, expect } from 'vitest'
import { historyToChatMessages } from './messages'
import type { StoredMessage } from '../../shared/protocol'

const msg = (role: 'user' | 'assistant', blocks: StoredMessage['content'], id: string = role): StoredMessage => ({
  id,
  role,
  content: blocks,
  createdAt: 0,
})

describe('historyToChatMessages', () => {
  it('maps user/assistant text blocks', () => {
    const out = historyToChatMessages([
      msg('user', [{ type: 'text', text: 'hi' }], 'u1'),
      msg('assistant', [{ type: 'text', text: 'hello' }], 'a1'),
    ])
    expect(out).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ])
  })

  it('concatenates multiple text blocks within one message', () => {
    const out = historyToChatMessages([msg('assistant', [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], 'a1')])
    expect(out).toEqual([{ role: 'assistant', content: 'ab' }])
  })

  it('skips non-text blocks (tool_use/tool_result/error) and drops empty messages', () => {
    const out = historyToChatMessages([
      msg('user', [{ type: 'text', text: 'q' }], 'u1'),
      msg('assistant', [{ type: 'error', message: 'boom' }], 'a1'),
      msg('user', [{ type: 'text', text: 'again' }], 'u2'),
    ])
    // error-only assistant dropped → two consecutive users merged
    expect(out).toEqual([{ role: 'user', content: 'q\nagain' }])
  })

  it('merges consecutive same-role messages with newline', () => {
    const out = historyToChatMessages([
      msg('user', [{ type: 'text', text: 'one' }], 'u1'),
      msg('user', [{ type: 'text', text: 'two' }], 'u2'),
    ])
    expect(out).toEqual([{ role: 'user', content: 'one\ntwo' }])
  })

  it('returns [] for empty history', () => {
    expect(historyToChatMessages([])).toEqual([])
  })
})
