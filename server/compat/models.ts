import { listConnections, getConnectionWithSecret, type ConnectionWithSecret, type DB } from '../store'
import type { ProviderConfig } from '../providers/index'
import type { PermissionPolicy } from '../permission'

export type ParsedModelId = { connName: string; policy: PermissionPolicy; model: string }

const AUTO_SUFFIX = '-auto'

// "<conn>/<model>" -> readonly; "<conn>-auto/<model>" -> auto. Split on the FIRST '/' so the model
// segment may contain further slashes (e.g. "openrouter/anthropic/claude-3.5-sonnet"). Returns null
// when the id is malformed (no slash, empty conn, empty model, or conn that is just "-auto").
export function parseModelId(id: string): ParsedModelId | null {
  const slash = id.indexOf('/')
  if (slash <= 0 || slash === id.length - 1) return null
  const connSpec = id.slice(0, slash)
  const model = id.slice(slash + 1)
  if (model === '') return null
  if (connSpec.endsWith(AUTO_SUFFIX)) {
    const connName = connSpec.slice(0, -AUTO_SUFFIX.length)
    if (connName === '') return null  // empty conn before -auto (e.g. "-auto/sonnet" -> invalid)
    return { connName, policy: 'auto', model }
  }
  return { connName: connSpec, policy: 'readonly', model }
}

// Compat model ids reference a connection by NAME (not its id). First match wins on duplicate names.
// Returns the row WITH its secret apiKey — server-side only; never put on the wire.
export function resolveConnectionByName(db: DB, name: string): ConnectionWithSecret | undefined {
  const meta = listConnections(db).find((c) => c.name === name)
  return meta ? getConnectionWithSecret(db, meta.id) : undefined
}

// makeProvider config from a resolved connection + the requested model (passed through as the default).
export function connectionToProviderConfig(conn: ConnectionWithSecret, model: string): ProviderConfig {
  const cfg: ProviderConfig = { type: conn.type, defaultModel: model }
  if (conn.baseUrl !== undefined) cfg.baseUrl = conn.baseUrl
  if (conn.apiKey !== undefined) cfg.apiKey = conn.apiKey
  return cfg
}

// Model ids advertised by GET /v1/models: "<name>/<defaultModel>" for every connection, plus
// "<name>-auto/<defaultModel>" for local-agent connections (the auto-permission variant).
export function listCompatModels(db: DB): string[] {
  const out: string[] = []
  for (const c of listConnections(db)) {
    out.push(`${c.name}/${c.defaultModel}`)
    if (c.type === 'local-agent') out.push(`${c.name}${AUTO_SUFFIX}/${c.defaultModel}`)
  }
  return out
}
