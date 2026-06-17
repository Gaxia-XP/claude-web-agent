import type {
  ServerMsg,
  StoredMessage,
  StoredContentBlock,
  Usage,
} from '../shared/protocol'
import type { Provider } from './providers/types'
import { InteractivePermissionResolver } from './permission'
import { runTurn } from './agent'
import {
  type DB,
  getChat,
  getChatSdkSession,
  setChatSdkSession,
  appendMessage,
} from './store'

export interface RuntimeDeps {
  db: DB
  provider: Provider
  broadcast: (m: ServerMsg) => void
  genId: () => string
  now: () => number
  turnTimeoutMs?: number
}

export class ChatRuntime {
  private permission: InteractivePermissionResolver
  private queue: string[] = []
  private running = false
  private disposed = false
  private currentAbort: AbortController | null = null

  constructor(
    private chatId: string,
    private deps: RuntimeDeps,
  ) {
    this.permission = new InteractivePermissionResolver(
      chatId,
      deps.broadcast,
      deps.genId,
    )
  }

  enqueue(text: string): void {
    // Persist the user message IMMEDIATELY (eagerly) so it is durable even if the turn
    // later aborts or is interrupted before it runs. interrupt() clears only the queue.
    const userMsg: StoredMessage & { chatId: string } = {
      chatId: this.chatId,
      id: this.deps.genId(),
      role: 'user',
      content: [{ type: 'text', text }],
      createdAt: this.deps.now(),
    }
    appendMessage(this.deps.db, userMsg)
    this.queue.push(text)
    void this.drain()
  }

  interrupt(): void {
    this.currentAbort?.abort()
    this.queue = [] // #6b: clear pending (unrun) turns; persisted user rows are untouched
    this.permission.cancelAll('interrupted by user')
  }

  handlePermissionResponse(requestId: string, decision: 'allow' | 'deny'): void {
    this.permission.handleResponse(requestId, decision)
  }

  dispose(): void {
    this.disposed = true
    this.currentAbort?.abort()
    this.permission.cancelAll('chat closed')
    this.queue = []
  }

  get isIdle(): boolean {
    return !this.running && this.queue.length === 0
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      while (this.queue.length > 0 && !this.disposed) {
        const userText = this.queue.shift()!
        await this.runOne(userText)
      }
    } finally {
      this.running = false
    }
  }

  private async runOne(userText: string): Promise<void> {
    const chat = getChat(this.deps.db, this.chatId)
    const sdkSessionId = getChatSdkSession(this.deps.db, this.chatId)

    const abort = new AbortController()
    this.currentAbort = abort

    // Accumulating send: forward to broadcast AND collect content blocks for the ONE
    // assistant row persisted at turn_done.
    let accumulatedText = ''
    const toolUseBlocks: StoredContentBlock[] = []
    const toolResultBlocks: StoredContentBlock[] = []
    const accumulatingSend = (m: ServerMsg): void => {
      this.deps.broadcast(m)
      if (m.type === 'assistant_delta') {
        accumulatedText += m.text
      } else if (m.type === 'tool_call') {
        toolUseBlocks.push({ type: 'tool_use', id: m.id, name: m.name, input: m.input })
      } else if (m.type === 'tool_result') {
        toolResultBlocks.push({ type: 'tool_result', id: m.id, result: m.result })
      }
    }

    const result = await runTurn(
      this.deps.provider,
      {
        userText,
        cwd: chat?.cwd,
        model: chat?.model ?? 'sonnet',
        sdkSessionId,
      },
      {
        chatId: this.chatId,
        send: accumulatingSend,
        permission: this.permission,
        signal: abort.signal,
        turnTimeoutMs: this.deps.turnTimeoutMs,
      },
    )

    this.currentAbort = null

    // Persist ONE assistant message: text block, then tool_use blocks, then tool_result blocks.
    const content: StoredContentBlock[] = []
    const text = accumulatedText !== '' ? accumulatedText : result.text
    if (text !== '') content.push({ type: 'text', text })
    content.push(...toolUseBlocks)
    content.push(...toolResultBlocks)

    const usage: Usage | undefined = result.usage
    const asstMsg: StoredMessage & { chatId: string } = {
      chatId: this.chatId,
      id: this.deps.genId(),
      role: 'assistant',
      content,
      usage,
      createdAt: this.deps.now(),
    }
    appendMessage(this.deps.db, asstMsg)

    if (result.sdkSessionId) {
      setChatSdkSession(this.deps.db, this.chatId, result.sdkSessionId, this.deps.now())
    }
  }
}
