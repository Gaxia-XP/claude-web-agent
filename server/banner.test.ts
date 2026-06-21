import { describe, it, expect } from 'vitest'
import { lanUrls } from './banner'

// A fake os.networkInterfaces() shape: non-internal IPv4 entries become URLs,
// internal (loopback) and IPv6 entries are filtered out.
const fakeInterfaces = {
  lo: [
    { address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '255.0.0.0', mac: '00:00:00:00:00:00', cidr: '127.0.0.1/8' },
    { address: '::1', family: 'IPv6', internal: true, netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', mac: '00:00:00:00:00:00', scopeid: 0, cidr: '::1/128' },
  ],
  eth0: [
    { address: '192.168.1.42', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: 'aa:bb:cc:dd:ee:ff', cidr: '192.168.1.42/24' },
    { address: 'fe80::1', family: 'IPv6', internal: false, netmask: 'ffff:ffff:ffff:ffff::', mac: 'aa:bb:cc:dd:ee:ff', scopeid: 2, cidr: 'fe80::1/64' },
  ],
  wlan0: [
    { address: '10.0.0.7', family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '11:22:33:44:55:66', cidr: '10.0.0.7/24' },
  ],
} as unknown as ReturnType<typeof import('node:os').networkInterfaces>

describe('lanUrls', () => {
  it('returns one http URL per non-internal IPv4 address', () => {
    expect(lanUrls(fakeInterfaces, 8787)).toEqual([
      'http://192.168.1.42:8787',
      'http://10.0.0.7:8787',
    ])
  })

  it('uses the supplied port', () => {
    expect(lanUrls(fakeInterfaces, 3000)).toEqual([
      'http://192.168.1.42:3000',
      'http://10.0.0.7:3000',
    ])
  })

  it('ignores internal and IPv6 addresses (loopback-only -> empty)', () => {
    const loopbackOnly = { lo: fakeInterfaces.lo } as unknown as ReturnType<typeof import('node:os').networkInterfaces>
    expect(lanUrls(loopbackOnly, 8787)).toEqual([])
  })

  it('tolerates undefined interface entries', () => {
    const withUndef = { lo: undefined, eth0: fakeInterfaces.eth0 } as unknown as ReturnType<typeof import('node:os').networkInterfaces>
    expect(lanUrls(withUndef, 8787)).toEqual(['http://192.168.1.42:8787'])
  })
})
