import { useEffect, useState } from 'react'
import type { FolderPickerState } from '../appState'

export function FolderPicker({
  state,
  onBrowse,
  onChoose,
  onClose,
}: {
  state: FolderPickerState
  onBrowse: (path: string) => void
  onChoose: (path: string) => void
  onClose: () => void
}) {
  const [draft, setDraft] = useState(state.path)

  useEffect(() => {
    setDraft(state.path)
  }, [state.path])

  if (!state.open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="flex max-h-[80vh] w-[90%] max-w-lg flex-col rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between border-b p-4">
          <h2 className="text-lg font-semibold">เลือกโฟลเดอร์</h2>
          <button className="text-gray-400 hover:text-gray-700" title="ปิด" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 border-b p-3">
          <button
            className="shrink-0 rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
            disabled={state.parent === undefined}
            onClick={() => {
              if (state.parent !== undefined) onBrowse(state.parent)
            }}
          >
            ↑ ขึ้น
          </button>
          <input
            className="min-w-0 flex-1 rounded-lg border px-3 py-1.5 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-400"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                onBrowse(draft)
              }
            }}
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          <p className="px-2 py-1 font-mono text-xs text-gray-500">{state.path}</p>
          {state.error && (
            <p className="mx-2 mb-1 rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-600">
              {state.error}
            </p>
          )}
          {state.entries.length === 0 ? (
            <p className="px-2 py-4 text-center text-sm text-gray-400">ไม่มีโฟลเดอร์ย่อย</p>
          ) : (
            <ul className="space-y-0.5">
              {state.entries.map((entry) => (
                <li key={entry.path}>
                  <button
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-gray-100"
                    onClick={() => onBrowse(entry.path)}
                  >
                    <span aria-hidden>📁</span>
                    <span className="truncate">{entry.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t p-4">
          <button className="rounded-lg border px-4 py-2 text-sm" onClick={onClose}>
            ยกเลิก
          </button>
          <button
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
            onClick={() => onChoose(state.path)}
          >
            เลือกโฟลเดอร์นี้
          </button>
        </div>
      </div>
    </div>
  )
}
