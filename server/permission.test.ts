import { describe, it, expect, vi } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { isReadOnlyTool, InteractivePermissionResolver } from './permission'

describe('isReadOnlyTool', () => {
  it('treats Read/Glob/Grep as read-only', () => {
    expect(isReadOnlyTool('Read')).toBe(true)
    expect(isReadOnlyTool('Grep')).toBe(true)
  })
  it('treats Write/Bash as NOT read-only', () => {
    expect(isReadOnlyTool('Write')).toBe(false)
    expect(isReadOnlyTool('Bash')).toBe(false)
  })
})

describe('InteractivePermissionResolver', () => {
  it('auto-allows read-only tools without sending a request', async () => {
    const sent: ServerMsg[] = []
    const r = new InteractivePermissionResolver((m) => sent.push(m), () => 'id1')
    const d = await r.resolve('Read', { file_path: '/a' })
    expect(d).toEqual({ behavior: 'allow' })
    expect(sent).toHaveLength(0)
  })

  it('sends a permission_request for write tools and resolves on allow', async () => {
    const sent: ServerMsg[] = []
    let id = 0
    const r = new InteractivePermissionResolver((m) => sent.push(m), () => `req${++id}`)
    const p = r.resolve('Write', { file_path: '/a' })
    expect(sent).toEqual([{ type: 'permission_request', requestId: 'req1', name: 'Write', input: { file_path: '/a' } }])
    r.handleResponse('req1', 'allow')
    await expect(p).resolves.toEqual({ behavior: 'allow' })
  })

  it('resolves deny with a message', async () => {
    const r = new InteractivePermissionResolver(() => {}, () => 'req1')
    const p = r.resolve('Bash', { command: 'rm -rf /' })
    r.handleResponse('req1', 'deny')
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'User denied' })
  })

  it('ignores responses for unknown requestId', () => {
    const r = new InteractivePermissionResolver(() => {}, () => 'x')
    expect(() => r.handleResponse('nonexistent', 'allow')).not.toThrow()
  })
})
