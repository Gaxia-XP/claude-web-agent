// Pure helpers for choosing which base URL the Settings auto-login QR encodes.
// The browser only knows location.origin; when the dashboard is opened on the server box that
// origin is http://localhost:PORT, which a phone cannot reach. The server reports its LAN urls via
// GET /api/lan-urls — these helpers combine the two so the QR points at a reachable address, and let
// the user switch (one of the LAN ips may be a VPN/virtual adapter). Pure -> unit-tested in env=node.

const LOOPBACK_HOST = /^(localhost|127(?:\.\d+){3}|\[::1\]|::1|0\.0\.0\.0)$/i

const stripTrailingSlashes = (u: string): string => u.replace(/\/+$/, '')

// True when the origin's host is loopback / non-routable (localhost, 127.x, ::1, 0.0.0.0).
export function hostIsLoopback(origin: string): boolean {
  try {
    return LOOPBACK_HOST.test(new URL(origin).hostname)
  } catch {
    return false
  }
}

// Candidate base URLs to offer for the QR: the current origin first (it's how the current viewer got
// here, so it's reachable for them), then any server-reported LAN urls, trailing-slash-normalized and
// deduped. Empty/blank entries are dropped.
export function qrCandidates(origin: string, lanUrls: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of [origin, ...lanUrls]) {
    const v = stripTrailingSlashes((raw ?? '').trim())
    if (v && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

// The base to encode by DEFAULT: if the page was opened on the server box (loopback origin) and the
// server reported at least one LAN url, prefer the first LAN url (a phone can't reach localhost).
// Otherwise keep the origin. Falls back to a normalized origin when there are no LAN urls.
export function defaultQrBase(origin: string, lanUrls: string[]): string {
  if (hostIsLoopback(origin) && lanUrls.length > 0) return stripTrailingSlashes(lanUrls[0])
  return stripTrailingSlashes(origin)
}

// The full auto-login URL the QR encodes: '<base>/#token=<token>'.
export function qrTarget(base: string, token: string): string {
  return `${stripTrailingSlashes(base)}/#token=${token}`
}
