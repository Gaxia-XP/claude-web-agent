import type {
  ServerMsg,
  StoredMessage,
  StoredContentBlock,
  Usage,
} from '../shared/protocol'
import type { Provider, TurnResult } from './providers/types'
import { InteractivePermissionResolver, type PermissionResolver } from './permission'
import { runTurn } from './agent'
import {
  type DB,
  getChat,
  getChatSdkSession,
  setChatSdkSession,
  appendMessage,
  listMessages,
} from './store'

export interface RuntimeDeps {
  db: DB
  provider: Provider
  broadcast: (m: ServerMsg) => void
  genId: () => string
  now: () => number
  turnTimeoutMs?: number
  onActivity?: () => void
}

export interface EnqueueOptions {
  // Per-turn permission resolver. Defaults to the chat's interactive (WS) resolver.
  // Native/compat API turns pass a PolicyPermissionResolver here.
  resolver?: PermissionResolver
  // Per-turn event sink, IN ADDITION to the hub broadcast (which stays wired so WS
  // subscribers still see the turn). Used by the native-API SSE/non-stream callers.
  onEvent?: (m: ServerMsg) => void
}

type QueueItem = {
  text: string
  resolver?: PermissionResolver
  onEvent?: (m: ServerMsg) => void
  settle: (result: TurnResult) => void
}

export class ChatRuntime {
  private permission: InteractivePermissionResolver
  private queue: QueueItem[] = []
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

  enqueue(text: string, opts: EnqueueOptions = {}): Promise<TurnResult> {
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
    let settle!: (result: TurnResult) => void
    const done = new Promise<TurnResult>((resolve) => {
      settle = resolve
    })
    this.queue.push({ text, resolver: opts.resolver, onEvent: opts.onEvent, settle })
    void this.drain()
    return done
  }

  interrupt(): void {
    this.currentAbort?.abort()
    // #6b: clear pending (unrun) turns; settle their promises so API callers never hang.
    // The persisted user rows are untouched.
    for (const item of this.queue) item.settle({ text: '' })
    this.queue = []
    this.permission.cancelAll('interrupted by user')
  }

  handlePermissionResponse(requestId: string, decision: 'allow' | 'deny'): void {
    this.permission.handleResponse(requestId, decision)
  }

  dispose(): void {
    this.disposed = true
    this.currentAbort?.abort()
    this.permission.cancelAll('chat closed')
    for (const item of this.queue) item.settle({ text: '' })
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
        const item = this.queue.shift()!
        await this.runOne(item)
      }
    } finally {
      this.running = false
    }
  }

  private async runOne(item: QueueItem): Promise<void> {
    const userText = item.text
    const chat = getChat(this.deps.db, this.chatId)
    const sdkSessionId = getChatSdkSession(this.deps.db, this.chatId)
    const history = listMessages(this.deps.db, this.chatId)

    const abort = new AbortController()
    this.currentAbort = abort

    // Accumulating send: forward to broadcast (WS live-sync) AND the per-turn onEvent sink
    // (HTTP/SSE caller) AND collect content blocks for the ONE assistant row.
    let accumulatedText = ''
    const toolUseBlocks: StoredContentBlock[] = []
    const toolResultBlocks: StoredContentBlock[] = []
    const errorMessages: string[] = []
    const accumulatingSend = (m: ServerMsg): void => {
      this.deps.broadcast(m)
      item.onEvent?.(m)
      if (m.type === 'assistant_delta') {
        accumulatedText += m.text
      } else if (m.type === 'tool_call') {
        toolUseBlocks.push({ type: 'tool_use', id: m.id, name: m.name, input: m.input })
      } else if (m.type === 'tool_result') {
        toolResultBlocks.push({ type: 'tool_result', id: m.id, result: m.result })
      } else if (m.type === 'error') {
        errorMessages.push(m.message)
      }
    }

    let result: TurnResult = { text: '' }
    try {
      result = await runTurn(
        this.deps.provider,
        {
          userText,
          cwd: chat?.cwd,
          model: chat?.model ?? 'sonnet',
          sdkSessionId,
          history,
        },
        {
          chatId: this.chatId,
          send: accumulatingSend,
          // Per-turn resolver: native-API turns pass a PolicyPermissionResolver; WS turns
          // fall back to the chat's shared interactive resolver.
          permission: item.resolver ?? this.permission,
          signal: abort.signal,
          turnTimeoutMs: this.deps.turnTimeoutMs,
        },
      )

      // #1: if the chat was deleted (dispose()) during the turn, skip persisting
      // to avoid a FOREIGN KEY constraint error.
      if (this.disposed) return

      // Build ONE assistant row. On a failed/timed-out turn (no content) persist an
      // error block so the failure survives reload; on a truly empty turn (e.g.
      // interrupted before any output) persist nothing.
      const content: StoredContentBlock[] = []
      const text = accumulatedText !== '' ? accumulatedText : result.text
      if (text !== '') content.push({ type: 'text', text })
      content.push(...toolUseBlocks)
      content.push(...toolResultBlocks)
      if (errorMessages.length > 0) {
        content.push({ type: 'error', message: errorMessages.join('\n') })
      }

      if (content.length > 0) {
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
      }

      if (result.sdkSessionId) {
        setChatSdkSession(this.deps.db, this.chatId, result.sdkSessionId, this.deps.now())
        // #5: notify hub so it can re-broadcast chat_list (sidebar recency order).
        if (!this.disposed) this.deps.onActivity?.()
      }
    } finally {
      // #2: always abort the provider's async iterator after every turn —
      // harmless on normal completion, critical on timeout to tear down the live query.
      abort.abort()
      // Deny any permission left parked by a timed-out/errored turn so the provider's
      // canUseTool promise never hangs across turns (server side of MAJOR#2).
      this.permission.cancelAll('turn ended')
      if (this.currentAbort === abort) this.currentAbort = null
      // Settle the per-turn promise exactly once with the (possibly empty) result so
      // native-API callers awaiting the turn always resolve — even on dispose/error.
      // Deferred by one microtask so drain's finally (running = false) completes first,
      // allowing isIdle to be true when the caller's await continuation resumes.
      void Promise.resolve().then(() => item.settle(result))
    }
  }
}
