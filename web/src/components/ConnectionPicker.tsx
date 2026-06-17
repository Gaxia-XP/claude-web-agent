import type { ConnectionMeta } from '@shared/protocol'

export function ConnectionPicker({
  connections,
  value,
  onChange,
}: {
  connections: ConnectionMeta[]
  value: string
  onChange: (id: string) => void
}) {
  return (
    <select
      className="w-full rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {connections.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name} ({c.type})
        </option>
      ))}
    </select>
  )
}
