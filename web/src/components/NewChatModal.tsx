import type { ConnectionMeta } from '@shared/protocol'
import { ConnectionPicker } from './ConnectionPicker'
import { ModelPicker } from './ModelPicker'

export type NewChatDraft = { connectionId: string; model: string; cwd?: string }

export function NewChatModal({
  draft,
  connections,
  onChange,
  onBrowse,
  onSubmit,
  onClose,
}: {
  draft: NewChatDraft
  connections: ConnectionMeta[]
  onChange: (d: NewChatDraft) => void
  onBrowse: () => void
  onSubmit: () => void
  onClose: () => void
}) {
  const selected = connections.find((c) => c.id === draft.connectionId)
  const providerType = selected?.type ?? 'local-agent'
  const isLocal = providerType === 'local-agent'

  const selectConnection = (id: string) => {
    const conn = connections.find((c) => c.id === id)
    onChange({ ...draft, connectionId: id, model: conn?.defaultModel ?? draft.model })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-3 sm:items-center sm:p-4">
      <div className="flex w-full max-w-md flex-col gap-3 rounded-xl bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">แชทใหม่</h2>
          <button className="text-gray-400 hover:text-gray-700" title="ปิด" onClick={onClose}>
            ✕
          </button>
        </div>

        <label className="text-sm font-medium text-gray-700">Connection</label>
        <ConnectionPicker connections={connections} value={draft.connectionId} onChange={selectConnection} />

        <label className="text-sm font-medium text-gray-700">Model</label>
        <ModelPicker
          providerType={providerType}
          value={draft.model}
          onChange={(model) => onChange({ ...draft, model })}
          id="newchat"
        />

        {isLocal && (
          <>
            <label className="text-sm font-medium text-gray-700">Working directory</label>
            <div className="flex items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-400"
                placeholder="(ไม่ระบุ = โฟลเดอร์เริ่มต้นของ server)"
                value={draft.cwd ?? ''}
                onChange={(e) => onChange({ ...draft, cwd: e.target.value || undefined })}
              />
              <button className="shrink-0 rounded-lg border px-3 py-2 text-sm" onClick={onBrowse}>
                เลือก…
              </button>
            </div>
          </>
        )}

        <div className="mt-2 flex justify-end gap-2">
          <button className="min-h-[44px] rounded-lg border px-4 py-2 text-sm" onClick={onClose}>
            ยกเลิก
          </button>
          <button
            className="min-h-[44px] rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
            disabled={!draft.connectionId || !draft.model.trim()}
            onClick={onSubmit}
          >
            สร้าง
          </button>
        </div>
      </div>
    </div>
  )
}
