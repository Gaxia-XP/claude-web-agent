// Token storage + URL-hash bootstrap for the single bearer token (M6 auth).
// parseTokenFromHash is pure (unit-tested in env=node). The getter/setter/
// bootstrap shells touch browser globals and are verified by tsc only.
const TOKEN_KEY = 'cwa_token'

// Pure: '#token=abc' -> 'abc'; '#token=' / '' / no-token -> null.
export function parseTokenFromHash(hash: string): string | null {
  // URLSearchParams wants the part after '#'; tolerate a leading '#' or '?'.
  const raw = hash.startsWith('#') ? hash.slice(1) : hash
  const token = new URLSearchParams(raw).get('token')
  return token && token.length > 0 ? token : null
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function setToken(t: string): void {
  localStorage.setItem(TOKEN_KEY, t)
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY)
}

// On load: if the URL carries '#token=...', persist it and strip the fragment
// (so the token is kept out of server logs and the visible address bar; note it
// may already have been recorded in the browser's local/synced history before
// this strip runs), then return the effective stored token.
export function bootstrapToken(): string | null {
  const fromHash = parseTokenFromHash(location.hash)
  if (fromHash) {
    setToken(fromHash)
    history.replaceState(null, '', location.pathname + location.search)
  }
  return getToken()
}
