// Assistant-style bubble shown while a turn is in flight before the first token.
export function TypingIndicator() {
  return (
    <div className="flex justify-start px-3 py-2 sm:px-4">
      <div className="rounded-2xl bg-gray-100 px-4 py-3" role="status" aria-label="กำลังตอบกลับ">
        <span className="flex gap-1">
          <span className="typing-dot h-2 w-2 rounded-full bg-gray-500" />
          <span className="typing-dot h-2 w-2 rounded-full bg-gray-500" />
          <span className="typing-dot h-2 w-2 rounded-full bg-gray-500" />
        </span>
      </div>
    </div>
  )
}
