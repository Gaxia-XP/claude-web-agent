import type { PermissionPrompt } from '../appState'

export function PermissionModal({
  prompt,
  onDecide,
}: {
  prompt: PermissionPrompt
  onDecide: (decision: 'allow' | 'deny') => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[90%] max-w-md rounded-xl bg-white p-5 shadow-xl">
        <h2 className="text-lg font-semibold">ขออนุญาตใช้เครื่องมือ</h2>
        <p className="mt-1 text-sm text-gray-600">
          Claude ต้องการใช้ <span className="font-mono font-semibold">{prompt.name}</span>
        </p>
        <pre className="mt-2 max-h-48 overflow-auto rounded bg-gray-100 p-2 text-xs">
          {JSON.stringify(prompt.input, null, 2)}
        </pre>
        <div className="mt-4 flex justify-end gap-2">
          <button className="rounded-lg border px-4 py-2" onClick={() => onDecide('deny')}>
            ปฏิเสธ
          </button>
          <button className="rounded-lg bg-blue-600 px-4 py-2 text-white" onClick={() => onDecide('allow')}>
            อนุญาต
          </button>
        </div>
      </div>
    </div>
  )
}
