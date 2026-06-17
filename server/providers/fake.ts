import type { Provider, ProviderContext, TurnParams, TurnResult } from './types'

/** Provider ปลอมสำหรับเทสต์ orchestration: ส่ง delta สองชิ้น, เรียก tool หนึ่งตัว (ผ่าน permission), แล้วจบ */
export class FakeProvider implements Provider {
  readonly type = 'fake'

  async send(params: TurnParams, ctx: ProviderContext): Promise<TurnResult> {
    ctx.onDelta('Hello ')
    ctx.onDelta(params.userText)
    const decision = await ctx.permission.resolve('Write', { file_path: '/tmp/x' })
    if (decision.behavior === 'allow') {
      ctx.onToolCall({ id: 't1', name: 'Write', input: { file_path: '/tmp/x' } })
      ctx.onToolResult('t1', 'written')
    }
    return { text: 'Hello ' + params.userText, usage: { outputTokens: 3 }, sdkSessionId: 'sess-1' }
  }
}
