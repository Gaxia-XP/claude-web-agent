import { describe, it, expect } from 'vitest'
import type { ServerMsg } from '../shared/protocol'
import { isReadOnlyTool, InteractivePermissionResolver, PolicyPermissionResolver } from './permission'

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
    const r = new InteractivePermissionResolver('c1', (m) => sent.push(m), () => 'id1')
    const d = await r.resolve('Read', { file_path: '/a' })
    expect(d).toEqual({ behavior: 'allow' })
    expect(sent).toHaveLength(0)
  })

  it('sends a permission_request (with chatId) for write tools and resolves on allow', async () => {
    const sent: ServerMsg[] = []
    let id = 0
    const r = new InteractivePermissionResolver('c1', (m) => sent.push(m), () => `req${++id}`)
    const p = r.resolve('Write', { file_path: '/a' })
    expect(sent).toEqual([
      { type: 'permission_request', chatId: 'c1', requestId: 'req1', name: 'Write', input: { file_path: '/a' } },
    ])
    r.handleResponse('req1', 'allow')
    await expect(p).resolves.toEqual({ behavior: 'allow' })
  })

  it('resolves deny with a message', async () => {
    const r = new InteractivePermissionResolver('c1', () => {}, () => 'req1')
    const p = r.resolve('Bash', { command: 'rm -rf /' })
    r.handleResponse('req1', 'deny')
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'User denied' })
  })

  it('ignores responses for unknown requestId', () => {
    const r = new InteractivePermissionResolver('c1', () => {}, () => 'x')
    expect(() => r.handleResponse('nonexistent', 'allow')).not.toThrow()
  })

  it('cancelAll settles pending promises with deny and clears the map', async () => {
    const r = new InteractivePermissionResolver('c1', () => {}, () => 'req1')
    const p = r.resolve('Write', { file_path: '/a' })
    r.cancelAll('connection closed')
    await expect(p).resolves.toEqual({ behavior: 'deny', message: 'connection closed' })
    expect(() => r.handleResponse('req1', 'allow')).not.toThrow()
  })

  it('handleResponse emits permission_resolved with chatId + requestId', async () => {
    const sent: ServerMsg[] = []
    let id = 0
    const r = new InteractivePermissionResolver('c1', (m) => sent.push(m), () => `req${++id}`)
    const p = r.resolve('Write', { file_path: '/a' })
    // clear the permission_request msg
    sent.length = 0
    r.handleResponse('req1', 'allow')
    await p
    expect(sent).toEqual([
      { type: 'permission_resolved', chatId: 'c1', requestId: 'req1' },
    ])
  })

  it('cancelAll emits permission_resolved for EACH pending requestId', async () => {
    const sent: ServerMsg[] = []
    let id = 0
    const r = new InteractivePermissionResolver('c1', (m) => sent.push(m), () => `req${++id}`)
    const p1 = r.resolve('Write', { file_path: '/a' })
    const p2 = r.resolve('Bash', { command: 'ls' })
    // clear the two permission_request msgs
    sent.length = 0
    r.cancelAll('watchdog timeout')
    await Promise.all([p1, p2])
    const resolved = sent.filter((m) => m.type === 'permission_resolved')
    expect(resolved).toHaveLength(2)
    const ids = resolved.map((m) => (m as { type: 'permission_resolved'; requestId: string }).requestId)
    expect(ids).toContain('req1')
    expect(ids).toContain('req2')
    // existing behaviour: promises denied
    await expect(p1).resolves.toEqual({ behavior: 'deny', message: 'watchdog timeout' })
    await expect(p2).resolves.toEqual({ behavior: 'deny', message: 'watchdog timeout' })
  })
})

describe('PolicyPermissionResolver', () => {
  it("'auto' mode allows every tool", async () => {
    const r = new PolicyPermissionResolver('auto')
    expect(await r.resolve('Read', {})).toEqual({ behavior: 'allow' })
    expect(await r.resolve('Write', { file_path: '/tmp/x' })).toEqual({ behavior: 'allow' })
    expect(await r.resolve('Bash', { command: 'ls' })).toEqual({ behavior: 'allow' })
  })

  it("'readonly' mode allows the read-only tool set", async () => {
    const r = new PolicyPermissionResolver('readonly')
    for (const t of ['Read', 'Glob', 'Grep', 'NotebookRead', 'WebSearch', 'WebFetch', 'TodoWrite']) {
      expect(await r.resolve(t, {})).toEqual({ behavior: 'allow' })
    }
  })

  it("'readonly' mode denies write/run tools with a message", async () => {
    const r = new PolicyPermissionResolver('readonly')
    const write = await r.resolve('Write', { file_path: '/tmp/x' })
    expect(write.behavior).toBe('deny')
    if (write.behavior === 'deny') expect(write.message).toMatch(/readonly/i)
    const bash = await r.resolve('Bash', { command: 'ls' })
    expect(bash.behavior).toBe('deny')
  })
})
