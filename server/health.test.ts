import { describe, it, expect } from 'vitest'
import { pingMessage } from './health'

describe('pingMessage', () => {
  it('returns a stable ping string', () => {
    expect(pingMessage()).toBe('claude-web-agent: ok')
  })
})
