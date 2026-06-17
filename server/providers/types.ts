import type { ToolCall, Usage, StoredMessage } from '../../shared/protocol'
import type { PermissionResolver } from '../permission'

export interface ProviderContext {
  onDelta(text: string): void
  onToolCall(call: ToolCall): void
  onToolResult(id: string, result: unknown): void
  permission: PermissionResolver
  signal: AbortSignal
}

export interface TurnParams {
  userText: string
  cwd?: string
  model?: string
  sdkSessionId?: string
  history?: StoredMessage[]
}

export interface TurnResult {
  text: string
  usage?: Usage
  sdkSessionId?: string
}

export interface Provider {
  readonly type: string
  send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult>
}
