// Thin fetch wrapper that attaches the bearer token. It does NOT handle 401
// itself — callers inspect res.status (Login probe, Settings model list).
export async function apiFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', 'Bearer ' + token)
  return fetch(path, { ...init, headers })
}
