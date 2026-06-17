import { readdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import type { DirEntry } from '../shared/protocol'

export async function listDirs(
  inputPath?: string,
): Promise<{ path: string; parent?: string; entries: DirEntry[] }> {
  const path = resolve(inputPath ?? homedir())
  const dirents = await readdir(path, { withFileTypes: true })
  const entries: DirEntry[] = dirents
    .filter((d) => d.isDirectory())
    .map((d) => ({ name: d.name, path: join(path, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const parentPath = dirname(path)
  const parent = parentPath === path ? undefined : parentPath
  return { path, parent, entries }
}
