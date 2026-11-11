/**
 * A plain node:fs implementation of the routes' `Files`, behaving like dsh's
 * local backend where the routes depend on it: targets keyed by real path,
 * symlinks followed, short reads at end of file, errors carrying FS_ codes.
 */

import { open, readdir, realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { FsDirEntry, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { Files } from '../src/files.ts'

class FakeFsError extends Error {
  readonly code: string
  constructor(message: string, code: string) {
    super(message)
    this.code = code
  }
}

function translate(error: unknown, path: string): never {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new FakeFsError(`${path}: not found`, 'FS_NOT_FOUND')
  if (code === 'EACCES' || code === 'EPERM') throw new FakeFsError(`${path}: permission denied`, 'FS_PERMISSION_DENIED')
  throw error
}

function target(displayPath: string, key: string): FsTarget {
  return { displayPath, targetKey: key } as unknown as FsTarget
}

async function info(path: string): Promise<FsInfo | undefined> {
  try {
    const s = await stat(path)
    const type = s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other'
    return { type, version: String(s.mtimeMs), ...(s.isFile() ? { size: s.size } : {}) } as unknown as FsInfo
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return translate(error, path)
  }
}

export class LocalFiles implements Files {
  /** Paths whose listing fails as permission denied, for refusal tests. */
  readonly denied = new Set<string>()
  /** Every byte range read, in order. */
  readonly reads: Array<{ path: string; offset: number; length: number }> = []

  /** Like dsh's: a path that does not exist resolves to itself; any other failure escapes as the system error. */
  async resolve(path: string): Promise<FsTarget> {
    const displayPath = resolve(path)
    try {
      return target(displayPath, await realpath(displayPath))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return target(displayPath, displayPath)
    }
  }

  stat(t: FsTarget): Promise<FsInfo | undefined> {
    return info(String(t.targetKey))
  }

  async listDir(t: FsTarget): Promise<FsDirEntry[]> {
    const key = String(t.targetKey)
    if (this.denied.has(t.displayPath)) throw new FakeFsError(`cannot list "${t.displayPath}": permission denied`, 'FS_PERMISSION_DENIED')
    let names: string[]
    try {
      names = (await readdir(key)).sort((a, b) => a.localeCompare(b))
    } catch (error) {
      return translate(error, t.displayPath)
    }
    const entries: FsDirEntry[] = []
    for (const name of names) {
      const child = await this.resolve(join(t.displayPath, name))
      const childInfo = await info(String(child.targetKey))
      if (childInfo === undefined) continue
      entries.push({ name, type: childInfo.type, target: child, ...(childInfo.size === undefined ? {} : { size: childInfo.size }) })
    }
    return entries
  }

  async readByteRange(t: FsTarget, range: { offset: number; length: number }): Promise<Uint8Array> {
    this.reads.push({ path: t.displayPath, ...range })
    let handle
    try {
      handle = await open(String(t.targetKey), 'r')
    } catch (error) {
      return translate(error, t.displayPath)
    }
    try {
      const buffer = new Uint8Array(range.length)
      const { bytesRead } = await handle.read(buffer, 0, range.length, range.offset)
      return buffer.subarray(0, bytesRead)
    } finally {
      await handle.close()
    }
  }
}
