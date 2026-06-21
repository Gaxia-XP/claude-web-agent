import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

// Load the bearer token from tokenPath, creating it on first run.
// Token = 32 random bytes base64url-encoded -> 43 URL-safe chars.
// Returns the trimmed token so an editor-added trailing newline is tolerated.
export function loadOrCreateToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    const existing = readFileSync(tokenPath, 'utf8').trim()
    if (existing) return existing
  }
  const token = randomBytes(32).toString('base64url')
  mkdirSync(dirname(tokenPath), { recursive: true })
  writeFileSync(tokenPath, token, 'utf8')
  // Best-effort owner-only perms; a no-op on Windows filesystems.
  try {
    chmodSync(tokenPath, 0o600)
  } catch {
    // ignore: chmod is not meaningful on Windows
  }
  return token
}

// Extract the token from an HTTP request: Authorization: Bearer <t> OR x-api-key: <t>.
export function extractToken(headers: import('http').IncomingHttpHeaders): string | undefined {
  const auth = headers.authorization
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim())
    if (match) return match[1].trim()
  }
  const apiKey = headers['x-api-key']
  if (typeof apiKey === 'string' && apiKey.trim()) return apiKey.trim()
  return undefined
}

// Extract the token from a WebSocket Sec-WebSocket-Protocol header value.
// Expected form: 'bearer, <token>'. Returns undefined when malformed.
export function extractWsToken(secWebSocketProtocol: string | undefined): string | undefined {
  if (!secWebSocketProtocol) return undefined
  const parts = secWebSocketProtocol.split(',').map((p) => p.trim())
  if (parts[0] === 'bearer' && parts[1]) return parts[1]
  return undefined
}

// Constant-time comparison with a length guard so length differences do not throw.
export function safeEqual(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
