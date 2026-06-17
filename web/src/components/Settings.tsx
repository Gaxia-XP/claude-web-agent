import { useState } from 'react'
import type { ConnectionMeta } from '@shared/protocol'
import { ModelPicker } from './ModelPicker'

export type ConnectionFormPayload = {
  name: string
  providerType: string
  baseUrl?: string
  apiKey?: string
  defaultModel: string
}

const NEW_TYPES = ['anthropic-api', 'openai-compatible']

function emptyForm(): ConnectionFormPayload {
  return { name: '', providerType: 'anthropic-api', defaultModel: 'claude-opus-4-8' }
}

export function Settings({
  connections,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
}: {
  connections: ConnectionMeta[]
  onCreate: (p: ConnectionFormPayload) => void
  onUpdate: (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string }) => void
  onDelete: (id: string) => void
  onClose: () => void
}) {
  // editId: undefined = not editing; '' = creating new; otherwise editing that id
  const [editId, setEditId] = useState<string | undefined>(undefined)
  const [form, setForm] = useState<ConnectionFormPayload>(emptyForm())

  const startCreate = () => {
    setEditId('')
    setForm(emptyForm())
  }
  const startEdit = (c: ConnectionMeta) => {
    setEditId(c.id)
    setForm({ name: c.name, providerType: c.type, baseUrl: c.baseUrl, defaultModel: c.defaultModel })
  }
  const cancel = () => setEditId(undefined)
  const submit = () => {
    if (editId === '') {
      onCreate(form)
    } else if (editId) {
      onUpdate(editId, {
        name: form.name,
        baseUrl: form.baseUrl,
        defaultModel: form.defaultModel,
        ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      })
    }
    setEditId(undefined)
  }

  const isOpenai = form.providerType === 'openai-compatible'

  return (
    <div className="flex h-full flex-1 flex-col bg-gray-50">
      <header className="flex items-center justify-between border-b bg-white px-4 py-3">
        <span className="text-lg font-semibold">Settings — Connections</span>
        <button className="rounded-lg border px-3 py-1.5 text-sm" onClick={onClose}>
          ← กลับไปแชท
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4">
        <ul className="space-y-2">
          {connections.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.name}</div>
                <div className="truncate text-xs text-gray-500">
                  {c.type} · {c.defaultModel}
                  {c.baseUrl ? ` · ${c.baseUrl}` : ''}
                </div>
              </div>
              <button className="rounded px-2 py-1 text-sm text-gray-600 hover:bg-gray-100" onClick={() => startEdit(c)}>
                แก้ไข
              </button>
              <button
                className="rounded px-2 py-1 text-sm text-red-600 hover:bg-red-50 disabled:opacity-40"
                disabled={c.id === 'local'}
                title={c.id === 'local' ? 'ลบ connection เริ่มต้นไม่ได้' : 'ลบ'}
                onClick={() => {
                  if (window.confirm(`ลบ connection "${c.name}" ?`)) onDelete(c.id)
                }}
              >
                ลบ
              </button>
            </li>
          ))}
        </ul>

        {editId === undefined ? (
          <button className="mt-4 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700" onClick={startCreate}>
            + เพิ่ม connection
          </button>
        ) : (
          <div className="mt-4 flex flex-col gap-3 rounded-xl border bg-white p-4">
            <h3 className="text-base font-semibold">{editId === '' ? 'เพิ่ม connection' : 'แก้ไข connection'}</h3>

            {editId === '' && (
              <>
                <label className="text-sm font-medium text-gray-700">ประเภท</label>
                <select
                  className="w-full rounded-lg border px-3 py-2 text-sm"
                  value={form.providerType}
                  onChange={(e) => {
                    const providerType = e.target.value
                    setForm((f) => ({
                      ...f,
                      providerType,
                      defaultModel: providerType === 'anthropic-api' ? 'claude-opus-4-8' : f.defaultModel,
                    }))
                  }}
                >
                  {NEW_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </>
            )}

            <label className="text-sm font-medium text-gray-700">ชื่อ</label>
            <input
              className="w-full rounded-lg border px-3 py-2 text-sm"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            />

            {isOpenai && (
              <>
                <label className="text-sm font-medium text-gray-700">Base URL</label>
                <input
                  className="w-full rounded-lg border px-3 py-2 font-mono text-sm"
                  placeholder="https://openrouter.ai/api/v1"
                  value={form.baseUrl ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value || undefined }))}
                />
              </>
            )}

            <label className="text-sm font-medium text-gray-700">
              API key{editId !== '' ? ' (เว้นว่าง = คงค่าเดิม)' : ''}
            </label>
            <input
              type="password"
              className="w-full rounded-lg border px-3 py-2 font-mono text-sm"
              placeholder={editId === '' ? 'sk-…' : '••••••••'}
              value={form.apiKey ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value || undefined }))}
            />

            <label className="text-sm font-medium text-gray-700">Default model</label>
            <ModelPicker
              providerType={form.providerType}
              value={form.defaultModel}
              onChange={(defaultModel) => setForm((f) => ({ ...f, defaultModel }))}
              id="settings"
            />

            <div className="mt-1 flex justify-end gap-2">
              <button className="rounded-lg border px-4 py-2 text-sm" onClick={cancel}>
                ยกเลิก
              </button>
              <button
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-40"
                disabled={!form.name.trim() || !form.defaultModel.trim() || (isOpenai && !form.baseUrl)}
                onClick={submit}
              >
                บันทึก
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
