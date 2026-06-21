import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { ConnectionMeta, ChatMeta } from '@shared/protocol'
import { ModelPicker } from './ModelPicker'
import { apiFetch } from '../api'

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
  chats,
  error,
  onCreate,
  onUpdate,
  onDelete,
  onClose,
  token,
  onLogout,
}: {
  connections: ConnectionMeta[]
  chats: ChatMeta[]
  error?: string
  onCreate: (p: ConnectionFormPayload) => void
  onUpdate: (id: string, patch: { name?: string; baseUrl?: string; apiKey?: string; defaultModel?: string }) => void
  onDelete: (id: string) => void
  onClose: () => void
  token: string
  onLogout: () => void
}) {
  // editId: undefined = not editing; '' = creating new; otherwise editing that id
  const [editId, setEditId] = useState<string | undefined>(undefined)
  const [form, setForm] = useState<ConnectionFormPayload>(emptyForm())

  // Harness panel state.
  const origin = location.origin
  const [revealToken, setRevealToken] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [qrSrc, setQrSrc] = useState<string | null>(null)
  const [modelIds, setModelIds] = useState<string[] | null>(null)
  const [modelError, setModelError] = useState<string | null>(null)

  // qrcode.toDataURL returns a Promise -> resolve into state, then <img src>.
  useEffect(() => {
    let alive = true
    QRCode.toDataURL(`${origin}/#token=${token}`)
      .then((src) => {
        if (alive) setQrSrc(src)
      })
      .catch(() => {
        if (alive) setQrSrc(null)
      })
    return () => {
      alive = false
    }
  }, [origin, token])

  // Pull the compat model-id list (proves token works + shows what to paste).
  useEffect(() => {
    let alive = true
    apiFetch('/v1/models', token)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('http ' + res.status))))
      .then((body: { data?: Array<{ id?: string }> }) => {
        if (!alive) return
        const ids = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string')
        setModelIds(ids)
        setModelError(null)
      })
      .catch(() => {
        if (!alive) return
        setModelIds(null)
        setModelError('โหลดรายการ model ไม่ได้')
      })
    return () => {
      alive = false
    }
  }, [token])

  const copy = (label: string, text: string) => {
    void navigator.clipboard?.writeText(text)
    setCopied(label)
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500)
  }

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
        {error && (
          <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </div>
        )}
        <ul className="space-y-2">
          {connections.map((c) => {
            const inUse = chats.some((chat) => chat.connectionId === c.id)
            const deleteDisabled = c.id === 'local' || inUse
            const deleteTitle = c.id === 'local'
              ? 'ลบ connection เริ่มต้นไม่ได้'
              : inUse
                ? 'ลบ connection ที่มีห้องอยู่ไม่ได้'
                : 'ลบ'
            return (
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
                  disabled={deleteDisabled}
                  title={deleteTitle}
                  onClick={() => {
                    if (window.confirm(`ลบ connection "${c.name}" ?`)) onDelete(c.id)
                  }}
                >
                  ลบ
                </button>
              </li>
            )
          })}
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

        <section className="mt-6 flex flex-col gap-3 rounded-xl border bg-white p-4">
          <h3 className="text-base font-semibold">เชื่อมต่อจากที่อื่น / Harness</h3>
          <p className="text-sm text-gray-500">
            ใช้ base URL + token ด้านล่างเสียบ harness ภายนอกหรือโปรเจกต์อื่นได้เลย
          </p>

          <div className="grid gap-2 text-sm">
            <div className="flex items-center justify-between gap-2 rounded-lg border bg-gray-50 px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs text-gray-500">Base URL (UI / native /api)</div>
                <div className="truncate font-mono">{origin}</div>
              </div>
              <button
                className="shrink-0 rounded-lg border px-3 py-2 text-xs"
                onClick={() => copy('origin', origin)}
              >
                {copied === 'origin' ? 'คัดลอกแล้ว' : 'คัดลอก'}
              </button>
            </div>

            <div className="flex items-center justify-between gap-2 rounded-lg border bg-gray-50 px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs text-gray-500">Base URL (compat /v1)</div>
                <div className="truncate font-mono">{origin}/v1</div>
              </div>
              <button
                className="shrink-0 rounded-lg border px-3 py-2 text-xs"
                onClick={() => copy('v1', `${origin}/v1`)}
              >
                {copied === 'v1' ? 'คัดลอกแล้ว' : 'คัดลอก'}
              </button>
            </div>

            <div className="flex items-center justify-between gap-2 rounded-lg border bg-gray-50 px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs text-gray-500">Token (= API key)</div>
                <div className="truncate font-mono">{revealToken ? token : '••••••••••••••••'}</div>
              </div>
              <div className="flex shrink-0 gap-1">
                <button
                  className="rounded-lg border px-3 py-2 text-xs"
                  onClick={() => setRevealToken((r) => !r)}
                >
                  {revealToken ? 'ซ่อน' : 'แสดง'}
                </button>
                <button className="rounded-lg border px-3 py-2 text-xs" onClick={() => copy('token', token)}>
                  {copied === 'token' ? 'คัดลอกแล้ว' : 'คัดลอก'}
                </button>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-center gap-2 rounded-lg border bg-gray-50 p-3">
            <div className="text-xs text-gray-500">สแกนเพื่อเข้าจากมือถือ (auto-login)</div>
            {qrSrc ? (
              <img src={qrSrc} alt="QR สำหรับ auto-login" className="h-44 w-44" />
            ) : (
              <div className="flex h-44 w-44 items-center justify-center text-xs text-gray-400">
                กำลังสร้าง QR…
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1">
            <div className="text-xs font-medium text-gray-500">Model ids (compat)</div>
            {modelError ? (
              <p className="text-xs text-red-500">{modelError}</p>
            ) : modelIds === null ? (
              <p className="text-xs text-gray-400">กำลังโหลด…</p>
            ) : modelIds.length === 0 ? (
              <p className="text-xs text-gray-400">ยังไม่มี model</p>
            ) : (
              <ul className="max-h-40 overflow-y-auto rounded-lg border bg-gray-50 p-2 font-mono text-xs">
                {modelIds.map((id) => (
                  <li key={id} className="truncate py-0.5">
                    {id}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-2 text-xs text-gray-600">
            <div className="rounded-lg border bg-gray-50 p-3">
              <div className="mb-1 font-medium text-gray-700">OpenAI-compatible</div>
              <div className="font-mono">base_url = {origin}/v1</div>
              <div className="font-mono">api_key = &lt;token&gt;</div>
            </div>
            <div className="rounded-lg border bg-gray-50 p-3">
              <div className="mb-1 font-medium text-gray-700">Anthropic</div>
              <div className="font-mono">ANTHROPIC_BASE_URL = {origin}</div>
              <div className="font-mono">x-api-key = &lt;token&gt;</div>
            </div>
          </div>

          <button
            className="mt-1 min-h-[44px] rounded-lg border border-red-200 px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
            onClick={onLogout}
          >
            ออกจากระบบ / Logout
          </button>
        </section>
      </div>
    </div>
  )
}
