import ReactMarkdown from 'react-markdown'
import type { UiMessage } from '../appState'
import { ToolCard } from './ToolCard'

export function Message({ msg }: { msg: UiMessage }) {
  if (msg.role === 'error') {
    return (
      <div className="flex justify-center px-3 py-2">
        <div className="max-w-[90%] rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm text-red-800">
          ⚠ {msg.text}
        </div>
      </div>
    )
  }
  const isUser = msg.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} px-3 py-2 sm:px-4`}>
      <div
        className={`max-w-[88%] rounded-2xl px-4 py-2 sm:max-w-[80%] ${
          isUser ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-900'
        }`}
      >
        {!isUser && msg.role === 'assistant' && msg.tools.map((t) => <ToolCard key={t.id} call={t} />)}
        <div className="prose prose-sm max-w-none break-words">
          <ReactMarkdown>{msg.text}</ReactMarkdown>
        </div>
        {!isUser && msg.role === 'assistant' && msg.usage && (msg.usage.inputTokens !== undefined || msg.usage.outputTokens !== undefined) && (
          <div className="mt-1 text-xs text-gray-500">
            ↑ {msg.usage.inputTokens ?? '–'} &nbsp; ↓ {msg.usage.outputTokens ?? '–'}
          </div>
        )}
      </div>
    </div>
  )
}
