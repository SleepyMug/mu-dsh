/**
 * The part of dsh's filesystem service (`ctx.fs`) the routes use. Taking it
 * as an interface keeps the routes on whatever backend the profile composes
 * (local, sandboxed, remote) and lets the tests supply a plain one.
 */

import type { FsDirEntry, FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import type { RefusalCode } from './wire.ts'

export interface Files {
  resolve(path: string, opts?: { signal?: AbortSignal }): Promise<FsTarget>
  stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined>
  listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]>
  readByteRange(target: FsTarget, range: { offset: number; length: number }, signal?: AbortSignal): Promise<Uint8Array>
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
