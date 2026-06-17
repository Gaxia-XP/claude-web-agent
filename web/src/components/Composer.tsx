import { useState } from 'react'

export function Composer({ disabled, onSend, onStop }: { disabled: boolean; onSend: (t: string) => void; onStop: () => void }) {
  const [text, setText] = useState('')
  const submit = () => {
    const t = text.trim()
    if (!t) return
    onSend(t)
    setText('')
  }
  return (
    <div className="flex items-end gap-2 border-t bg-white p-3">
      <textarea
        className="flex-1 resize-none rounded-lg border px-3 py-2 outline-none focus:ring-2 focus:ring-blue-400"
        rows={2}
        placeholder="พิมพ์ข้อความ… (Enter ส่ง, Shift+Enter ขึ้นบรรทัด)"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
      />
      {disabled ? (
        <button className="rounded-lg bg-red-500 px-4 py-2 text-white" onClick={onStop}>
          Stop
        </button>
      ) : (
        <button className="rounded-lg bg-blue-600 px-4 py-2 text-white" onClick={submit}>
          ส่ง
        </button>
      )}
    </div>
  )
}
