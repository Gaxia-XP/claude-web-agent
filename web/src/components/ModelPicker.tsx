export const MODEL_SUGGESTIONS: Record<string, string[]> = {
  'local-agent': ['sonnet', 'opus', 'haiku'],
  'anthropic-api': ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  'openai-compatible': [],
}

export function ModelPicker({
  providerType,
  value,
  onChange,
  id,
}: {
  providerType: string
  value: string
  onChange: (v: string) => void
  id: string
}) {
  const listId = `models-${id}`
  const suggestions = MODEL_SUGGESTIONS[providerType] ?? []
  return (
    <>
      <input
        list={listId}
        className="w-full rounded-lg border px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-blue-400"
        placeholder="model id"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {suggestions.map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  )
}
