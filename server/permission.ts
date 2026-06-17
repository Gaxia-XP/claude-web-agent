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
    private send: (m: ServerMsg) => void,
    private genId: () => string,
  ) {}

  async resolve(toolName: string, input: unknown): Promise<PermissionDecision> {
    if (isReadOnlyTool(toolName)) return { behavior: 'allow' }
    const requestId = this.genId()
    this.send({ type: 'permission_request', requestId, name: toolName, input })
    return new Promise<PermissionDecision>((resolve) => {
      this.pending.set(requestId, resolve)
    })
  }

  handleResponse(requestId: string, decision: 'allow' | 'deny'): void {
    const fn = this.pending.get(requestId)
    if (!fn) return
    this.pending.delete(requestId)
    fn(decision === 'allow' ? { behavior: 'allow' } : { behavior: 'deny', message: 'User denied' })
  }

  cancelAll(message: string): void {
    for (const fn of this.pending.values()) {
      fn({ behavior: 'deny', message })
    }
    this.pending.clear()
  }
}
