/**
 * The part of dsh's filesystem service (`ctx.fs`) the routes use. Taking it
 * as an interface keeps the routes on whatever backend the profile composes
 * (local, sandboxed, remote) and lets the tests supply a plain one.
 */

import type { FsDirEntry, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { Refusal, RefusalCode } from './wire.ts'

export interface Files {
  resolve(path: string, opts?: { signal?: AbortSignal }): Promise<FsTarget>
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
  readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
}

/** The watch route's part: `ctx.fs.watch`, which observes a file or a directory's direct entries. */
export interface WatchFiles extends Files {
  watch(target: FsTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>
}

export type { FsTarget }

/** The FsError codes of the system errors a backend lets through unwrapped. */
const ERRNO: Readonly<Record<string, string>> = {
  EACCES: 'FS_PERMISSION_DENIED',
  EPERM: 'FS_PERMISSION_DENIED',
  ENOENT: 'FS_NOT_FOUND',
  ENOTDIR: 'FS_NOT_FOUND',
  ELOOP: 'FS_NOT_FOUND',
  ENAMETOOLONG: 'FS_NOT_FOUND',
}

/**
 * The FsError code of a filesystem failure, or `undefined` for anything else.
 * dsh's FsError is recognized by its code: this plugin is bundled apart from
 * dsh, so its copy of the class would not be the one dsh throws. dsh's local
 * backend also lets some system errors through as they are (resolving a path
 * under a directory it may not search fails with EACCES); those map to the
 * FsError code they mean.
 */
export function fsErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return undefined
  return code.startsWith('FS_') ? code : ERRNO[code]
}

/**
 * A failure as a refusal the browser can show. A watch may fail with an
 * ordinary exception (dsh says so of watch initialization), which is not a
 * bug of this plugin but a fact about the path, so it is reported too.
 */
export function refusalOf(error: unknown): Refusal {
  const code = fsErrorCode(error)
  const message = error instanceof Error ? error.message : String(error)
  return { error: code === undefined ? 'unavailable' : refusalFor(code).error, message }
}

/** How a filesystem refusal reaches the browser. */
export function refusalFor(code: string): { status: number; error: RefusalCode } {
  switch (code) {
    case 'FS_NOT_FOUND': return { status: 404, error: 'not-found' }
    case 'FS_PERMISSION_DENIED':
    case 'FS_SANDBOX_DENIED': return { status: 403, error: 'not-permitted' }
    case 'FS_NOT_REGULAR_FILE':
    case 'FS_NOT_DIRECTORY': return { status: 409, error: 'not-regular' }
    case 'FS_TOO_LARGE': return { status: 413, error: 'too-large' }
    case 'FS_ABORTED': return { status: 499, error: 'unavailable' }
    default: return { status: 500, error: 'unavailable' }
  }
}
