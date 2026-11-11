/** `GET /api/mu-dsh-files.entry`: what a path is, and a directory's entries. */

import type { Files } from './files.ts'
import { json, refuse, refuseError, requestedPath } from './http.ts'
import type { DirectoryEntry, Entry } from './wire.ts'

/** Entries one listing returns at most; a larger directory is marked truncated. */
export const LIST_LIMIT = 10_000

export async function entry(files: Files, request: Request, listLimit = LIST_LIMIT): Promise<Response> {
  const path = requestedPath(request)
  if (path instanceof Response) return path
  const { signal } = request
  try {
    const target = await files.resolve(path, { signal })
    const info = await files.stat(target, signal)
    if (info === undefined) return refuse(404, 'not-found', `${path} does not exist`)
    let body: Entry
    if (info.type === 'directory') {
      const listed = await files.listDir(target, signal)
      const entries = listed.slice(0, listLimit).map((child): DirectoryEntry => (
        child.size === undefined ? { name: child.name, type: child.type } : { name: child.name, type: child.type, size: child.size }
      ))
      body = { type: 'directory', path: target.displayPath, entries, truncated: listed.length > listLimit }
    } else if (info.type === 'file') {
      body = info.size === undefined ? { type: 'file', path: target.displayPath } : { type: 'file', path: target.displayPath, size: info.size }
    } else {
      body = { type: 'other', path: target.displayPath }
    }
    return json(body)
  } catch (error) {
    return refuseError(error)
  }
}
