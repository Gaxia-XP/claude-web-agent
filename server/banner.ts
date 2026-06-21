import type { networkInterfaces } from 'node:os'

// Build one http URL per non-internal IPv4 address from os.networkInterfaces().
// Loopback (internal) and IPv6 entries are filtered out. Pure + deterministic
// (insertion order of the interfaces object), so it is unit-tested directly.
export function lanUrls(
  interfaces: ReturnType<typeof networkInterfaces>,
  port: number,
): string[] {
  const urls: string[] = []
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue
    for (const iface of entries) {
      if (iface.family === 'IPv4' && !iface.internal) {
        urls.push(`http://${iface.address}:${port}`)
      }
    }
  }
  return urls
}
