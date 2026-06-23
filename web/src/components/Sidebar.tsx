import type { ChatMeta } from '@shared/protocol'

export function Sidebar({
  chats,
  activeChatId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: {
  chats: ChatMeta[]
  activeChatId?: string
  onSelect: (id: string) => void
  onNew: () => void
  onRename: (id: string, title: string) => void
  onDelete: (id: string) => void
}) {
  const handleRename = (chat: ChatMeta) => {
    const next = window.prompt('เปลี่ยนชื่อแชท', chat.title)
    if (next === null) return
    const trimmed = next.trim()
    if (!trimmed || trimmed === chat.title) return
    onRename(chat.id, trimmed)
  }

  const handleDelete = (chat: ChatMeta) => {
    if (!window.confirm(`ลบแชท "${chat.title}" ?`)) return
    onDelete(chat.id)
  }

  return (
    <aside className="flex h-full w-64 flex-col border-r bg-gray-50 shadow-lg md:shadow-none">
      <div className="border-b p-3">
        <button
          className="w-full rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
          onClick={onNew}
        >
          + แชทใหม่
        </button>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        {chats.length === 0 ? (
          <p className="px-2 py-4 text-center text-sm text-gray-500">ยังไม่มีแชท</p>
        ) : (
          <ul className="space-y-1">
            {chats.map((chat) => {
              const active = chat.id === activeChatId
              return (
                <li
                  key={chat.id}
                  className={
                    'flex items-center gap-1 rounded-lg px-2 py-2 text-sm ' +
                    (active ? 'bg-blue-100 text-blue-900' : 'hover:bg-gray-200')
                  }
                >
                  <button
                    className="min-w-0 flex-1 truncate text-left"
                    title={chat.title}
                    onClick={() => onSelect(chat.id)}
                  >
                    {chat.title}
                  </button>
                  <button
                    className="shrink-0 rounded p-1.5 text-gray-500 hover:bg-gray-200 hover:text-gray-700"
                    aria-label={`เปลี่ยนชื่อแชท ${chat.title}`}
                    title="เปลี่ยนชื่อ"
                    onClick={() => handleRename(chat)}
                  >
                    ✎
                  </button>
                  <button
                    className="shrink-0 rounded p-1.5 text-gray-500 hover:bg-red-50 hover:text-red-600"
                    aria-label={`ลบแชท ${chat.title}`}
                    title="ลบ"
                    onClick={() => handleDelete(chat)}
                  >
                    🗑
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </nav>
    </aside>
  )
}
