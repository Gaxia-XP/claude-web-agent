import type { ToolCall } from '@shared/protocol'

export function ToolCard({ call }: { call: ToolCall }) {
  return (
    <div className="my-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs">
      <span className="font-semibold text-amber-800">⚙ {call.name}</span>
      <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-amber-900">
        {JSON.stringify(call.input, null, 2)}
      </pre>
    </div>
  )
}
