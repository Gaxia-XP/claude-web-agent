// Flatten an SDK tool_result `content` value into a single display string.
// - string            -> returned as-is
// - array             -> join the text of {type:"text",text} blocks (ignore others) with "\n"
// - single text block -> its text
// - null / undefined  -> ""
// - anything else      -> JSON.stringify(raw)
export function normalizeToolResult(raw: unknown): string {
  if (raw == null) return ''
  if (typeof raw === 'string') return raw

  if (Array.isArray(raw)) {
    return raw
      .filter(
        (b): b is { type: 'text'; text: string } =>
          typeof b === 'object' &&
          b !== null &&
          (b as { type?: unknown }).type === 'text' &&
          typeof (b as { text?: unknown }).text === 'string',
      )
      .map((b) => b.text)
      .join('\n')
  }

  if (
    typeof raw === 'object' &&
    (raw as { type?: unknown }).type === 'text' &&
    typeof (raw as { text?: unknown }).text === 'string'
  ) {
    return (raw as { text: string }).text
  }

  return JSON.stringify(raw)
}
