import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { listDirs } from './fsbrowse'

describe('listDirs', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'fsbrowse-'))
    await mkdir(join(tmp, 'alpha'))
    await mkdir(join(tmp, 'beta'))
    await writeFile(join(tmp, 'note.txt'), 'hello')
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('returns only directories, sorted by name, with absolute paths', async () => {
    const result = await listDirs(tmp)
    expect(result.path).toBe(tmp)
    expect(result.entries).toEqual([
      { name: 'alpha', path: join(tmp, 'alpha') },
      { name: 'beta', path: join(tmp, 'beta') },
    ])
  })

  it('excludes files (note.txt is not in the entries)', async () => {
    const result = await listDirs(tmp)
    const names = result.entries.map((e) => e.name)
    expect(names).not.toContain('note.txt')
  })

  it('sets parent to dirname of the path', async () => {
    const result = await listDirs(tmp)
    expect(result.parent).toBe(dirname(tmp))
  })

  it('defaults to the home directory when no argument is given', async () => {
    const result = await listDirs()
    expect(result.path).toBe(homedir())
    expect(Array.isArray(result.entries)).toBe(true)
  })

  it('rejects on a nonexistent path', async () => {
    await expect(listDirs(join(tmp, 'does-not-exist'))).rejects.toThrow()
  })
})
