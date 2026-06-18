import type { ServerMsg } from '../shared/protocol'

export const READ_ONLY_TOOLS = new Set<string>([
  'Read', 'Glob', 'Grep', 'NotebookRead', 'WebSearch', 'WebFetch', 'TodoWrite',
])

export function isReadOnlyTool(name: string): boolean {
  return READ_ONLY_TOOLS.has(name)
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: unknown }
  | { behavior: 'deny'; message: string }

export interface PermissionResolver {
  resolve(toolName: string, input: unknown): Promise<PermissionDecision>
}

export class InteractivePermissionResolver implements PermissionResolver {
  private pending = new Map<string, (d: PermissionDecision) => void>()

  constructor(
    private chatId: string,
    private send: (m: ServerMsg) => void,
    private genId: () => string,
  ) {}

  async resolve(toolName: string, input: unknown): Promise<PermissionDecision> {
    if (isReadOnlyTool(toolName)) return { behavior: 'allow' }
    const requestId = this.genId()
    this.send({ type: 'permission_request', chatId: this.chatId, requestId, name: toolName, input })
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, resolve)
    })
  }

  handleResponse(requestId: string, decision: 'allow' | 'deny'): void {
    const fn = this.pending.get(requestId)
    if (!fn) return
    this.pending.delete(requestId)
    fn(decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'User denied' })
    this.send({ type: 'permission_resolved', chatId: this.chatId, requestId })
  }

  cancelAll(message: string): void {
    for (const [requestId, fn] of this.pending.entries()) {
      fn({ behavior: 'deny', message })
      this.send({ type: 'permission_resolved', chatId: this.chatId, requestId })
    }
    this.pending.clear()
  }
}

// Non-interactive resolver for native/compat API turns: decides tool permission from a
// fixed policy instead of prompting a human. 'auto' allows everything; 'readonly' allows
// only the read-only tool set and denies writes/commands. It emits no ServerMsg and parks
// no promise — so it needs none of the interactive resolver's chatId/send/genId deps, and
// no cancelAll/handleResponse (it is passed only as a per-turn resolver into runTurn, never
// stored as ChatRuntime's lifecycle resolver).
export type PermissionPolicy = 'readonly' | 'auto'

export class PolicyPermissionResolver implements PermissionResolver {
  constructor(private mode: PermissionPolicy) {}

  async resolve(toolName: string, _input: unknown): Promise<PermissionDecision> {
    if (this.mode === 'auto') return { behavior: 'allow' }
    if (isReadOnlyTool(toolName)) return { behavior: 'allow' }
    return { behavior: 'deny', message: `readonly policy denies tool ${toolName}` }
  }
}
