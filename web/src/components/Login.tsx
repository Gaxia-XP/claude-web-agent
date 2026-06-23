import { useState } from 'react'
import { apiFetch } from '../api'
import { setToken } from '../auth'

// Standalone login gate: paste the bearer token, probe a guarded route to
// validate it, then hand the token up to Root (main.tsx) on success.
export function Login({ onAuthed }: { onAuthed: (token: string) => void }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    const token = value.trim()
    if (!token || busy) return
    setBusy(true)
    setError(null)
    try {
      // Probe a GUARDED route (not /api/health, which is allow-listed).
      const res = await apiFetch('/v1/models', token)
      if (res.ok) {
        setToken(token)
        onAuthed(token)
        return
      }
      setError('token ไม่ถูกต้อง / invalid or expired token')
    } catch {
      setError('เชื่อมต่อไม่ได้ / could not reach the server')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center bg-gray-50 px-4 py-10">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-2xl border bg-white p-6 shadow-sm sm:p-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-semibold">Claude Web Agent</h1>
          <p className="text-sm text-gray-500">วาง token เพื่อเชื่อมต่อ</p>
        </div>

        <label className="text-sm font-medium text-gray-700" htmlFor="login-token">
          Token
        </label>
        <input
          id="login-token"
          type="password"
          autoComplete="off"
          className="w-full rounded-lg border px-3 py-3 font-mono text-base outline-none focus:ring-2 focus:ring-blue-400"
          placeholder="วาง token ที่นี่"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void submit()
            }
          }}
        />

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-600">
            {error}
          </div>
        )}

        <button
          className="min-h-[44px] w-full rounded-lg bg-blue-600 px-4 py-3 text-base font-medium text-white hover:bg-blue-700 disabled:opacity-40"
          disabled={!value.trim() || busy}
          onClick={() => void submit()}
        >
          {busy ? 'กำลังเชื่อมต่อ…' : 'เชื่อมต่อ'}
        </button>

        <p className="text-center text-xs text-gray-500">
          สแกน QR จากหน้า Settings บนเครื่องที่รัน server เพื่อเข้าอัตโนมัติ
        </p>
      </div>
    </div>
  )
}
