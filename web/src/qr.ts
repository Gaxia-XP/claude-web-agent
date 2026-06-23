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

// Rank a base URL by how likely a phone on the real LAN can reach it (lower = better). A dev box
// often carries virtual / VPN adapters whose ips a phone cannot route to: CGNAT (Tailscale,
// 100.64.0.0/10), link-local / APIPA (169.254.0.0/16), and the VirtualBox host-only default
// (192.168.56.0/24). Those sink below ordinary private-LAN ips so the auto-login QR defaults to an
// address the phone can actually open. Ties keep input order.
function baseRank(base: string): number {
  let host: string
  try {
    host = new URL(base).hostname
  } catch {
    return 7
  }
  if (LOOPBACK_HOST.test(host)) return 6
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(host)
  if (!m) return 1 // a hostname (tunnel etc.) — routable, but prefer a plain LAN ip
  const a = Number(m[1])
  const b = Number(m[2])
  const c = Number(m[3])
  if (a === 169 && b === 254) return 5 // link-local / APIPA
  if (a === 100 && b >= 64 && b <= 127) return 4 // CGNAT (Tailscale) 100.64.0.0/10
  if (a === 192 && b === 168 && c === 56) return 3 // VirtualBox host-only default
  const isPrivateLan = (a === 192 && b === 168) || a === 10 || (a === 172 && b >= 16 && b <= 31)
  if (isPrivateLan) return 0 // ordinary private LAN — most reachable
  return 2 // some other ipv4
}

// LAN urls trailing-slash-normalized, blanks dropped, sorted best-reachable first (stable sort, so
// equal-rank ips keep the server's order).
function rankedLanUrls(lanUrls: string[]): string[] {
  return lanUrls
    .map((u) => stripTrailingSlashes((u ?? '').trim()))
    .filter((u) => u.length > 0)
    .sort((x, y) => baseRank(x) - baseRank(y))
}

// Candidate base URLs to offer for the QR: the current origin first (it's how the current viewer got
// here, so it's reachable for them), then any server-reported LAN urls, best-reachable first,
// trailing-slash-normalized and deduped. Empty/blank entries are dropped.
export function qrCandidates(origin: string, lanUrls: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (v: string): void => {
    if (v && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  push(stripTrailingSlashes((origin ?? '').trim()))
  for (const u of rankedLanUrls(lanUrls)) push(u)
  return out
}

// The base to encode by DEFAULT: if the page was opened on the server box (loopback origin) and the
// server reported at least one LAN url, prefer the best-reachable one (a phone can't reach localhost,
// and the first reported ip may be a VPN/virtual adapter). Otherwise keep the origin. Falls back to a
// normalized origin when there are no usable LAN urls.
export function defaultQrBase(origin: string, lanUrls: string[]): string {
  if (hostIsLoopback(origin)) {
    const ranked = rankedLanUrls(lanUrls)
    if (ranked.length > 0) return ranked[0]
  }
  return stripTrailingSlashes(origin)
}

// The full auto-login URL the QR encodes: '<base>/#token=<token>'.
export function qrTarget(base: string, token: string): string {
  return `${stripTrailingSlashes(base)}/#token=${token}`
}
