/**
 * `GET`/`HEAD /api/mu-dsh-files.download`: a regular file as itself, a
 * directory as a ZIP archive, streamed in chunks through `ctx.fs` so neither
 * is held in memory.
 *
 * A directory is walked in full before the first byte is sent, so a refusal
 * (too many entries, too many bytes, an unreadable subdirectory) is an HTTP
 * status rather than a broken archive. A file that shrinks while it is read
 * fails the stream, which the browser reports as a failed download; one that
 * grows is read up to the size the walk saw.
 */

import { basename } from 'node:path'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import type { Files, FsTarget } from './files.ts'
import { attachment, bodyless, headers, refuse, refuseError, requestedPath } from './http.ts'

export interface Limits {
  /** Entries in one archive; the format without ZIP64, which fflate writes, holds 65535. */
  readonly maxEntries: number
  /** Bytes of file content in one archive, kept well below the format's 4 GiB offsets. */
  readonly maxBytes: number
  /** Bytes per filesystem read. */
  readonly chunkBytes: number
}

export const LIMITS: Limits = { maxEntries: 65_535, maxBytes: 2 * 1024 ** 3, chunkBytes: 1024 ** 2 }

/** Already-compressed formats are stored rather than deflated again. */
const STORED = new Set([
  '7z', 'avif', 'br', 'bz2', 'docx', 'epub', 'flac', 'gif', 'gz', 'heic', 'jar', 'jpeg', 'jpg', 'lz4', 'm4a',
  'mkv', 'mov', 'mp3', 'mp4', 'odp', 'ods', 'odt', 'ogg', 'opus', 'png', 'pptx', 'rar', 'tgz', 'webm', 'webp',
  'whl', 'xlsx', 'xz', 'zip', 'zst',
])

type Item =
  | { readonly kind: 'file'; readonly name: string; readonly path: string; readonly target: FsTarget; readonly size: number }
  | { readonly kind: 'directory'; readonly name: string }

export async function download(files: Files, request: Request, limits: Limits = LIMITS): Promise<Response> {
  const head = request.method === 'HEAD'
  const path = requestedPath(request)
  if (path instanceof Response) return head ? bodyless(path) : path
  const { signal } = request
  try {
    const target = await files.resolve(path, { signal })
    const info = await files.stat(target, signal)
    if (info === undefined) return answer(head, refuse(404, 'not-found', `${path} does not exist`))
    const name = basename(target.displayPath) || 'root'
    if (info.type === 'file') {
      const fileHeaders = headers({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': attachment(name) })
      if (info.size !== undefined) fileHeaders['Content-Length'] = String(info.size)
      if (head) return new Response(null, { headers: fileHeaders })
      return new Response(streamOf(fileBytes(files, target, info.size, limits.chunkBytes, signal)), { headers: fileHeaders })
    }
    if (info.type !== 'directory') return answer(head, refuse(409, 'not-regular', `${path} is neither a file nor a directory`))
    const items = await plan(files, target, name, limits, signal)
    if (items instanceof Response) return answer(head, items)
    const zipHeaders = headers({ 'Content-Type': 'application/zip', 'Content-Disposition': attachment(`${name}.zip`) })
    if (head) return new Response(null, { headers: zipHeaders })
    return new Response(streamOf(archive(files, items, limits.chunkBytes, signal)), { headers: zipHeaders })
  } catch (error) {
    return answer(head, refuseError(error))
  }
}

function answer(head: boolean, response: Response): Response {
  return head ? bodyless(response) : response
}

/**
 * Every entry of the archive, depth first in the backend's order, under a
 * top-level folder named after the directory. Directories are entered once
 * each by their resolved identity, so a symlink back up the tree or to a
 * sibling adds nothing twice; only empty directories get an entry of their own.
 */
async function plan(files: Files, root: FsTarget, rootName: string, limits: Limits, signal: AbortSignal): Promise<Item[] | Response> {
  const items: Item[] = []
  const entered = new Set<string>([String(root.targetKey)])
  let bytes = 0
  const tooLarge = (): Response => refuse(413, 'too-large',
    `${rootName} holds more than ${limits.maxEntries} entries or ${limits.maxBytes} bytes, more than one archive may`)
  const visit = async (directory: FsTarget, prefix: string): Promise<Response | undefined> => {
    const children = await files.listDir(directory, signal)
    if (children.length === 0) items.push({ kind: 'directory', name: `${prefix}/` })
    for (const child of children) {
      if (signal.aborted) throw signal.reason
      const name = `${prefix}/${child.name}`
      if (child.type === 'directory') {
        const key = String(child.target.targetKey)
        if (entered.has(key)) continue
        entered.add(key)
        const refused = await visit(child.target, name)
        if (refused !== undefined) return refused
      } else if (child.type === 'file') {
        const size = child.size ?? (await files.stat(child.target, signal))?.size
        if (size === undefined) continue // gone since it was listed
        bytes += size
        items.push({ kind: 'file', name, path: child.target.displayPath, target: child.target, size })
      }
      if (items.length > limits.maxEntries || bytes > limits.maxBytes) return tooLarge()
    }
    return undefined
  }
  const refused = await visit(root, rootName)
  return refused ?? items
}

async function* fileBytes(files: Files, target: FsTarget, size: number | undefined, chunkBytes: number, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let offset = 0
  while (size === undefined || offset < size) {
    const length = size === undefined ? chunkBytes : Math.min(chunkBytes, size - offset)
    const data = await files.readByteRange(target, { offset, length }, signal)
    if (data.length === 0) {
      if (size === undefined) return
      throw new Error(`${target.displayPath} shrank from ${size} bytes while it was being sent`)
    }
    offset += data.length
    yield data
    if (size === undefined && data.length < length) return
  }
}

async function* archive(files: Files, items: readonly Item[], chunkBytes: number, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const out: Uint8Array[] = []
  let failure: Error | null = null
  const zip = new Zip((error, data) => {
    if (error !== null) failure = error
    else if (data.length > 0) out.push(data)
  })
  const flushed = function* (): Generator<Uint8Array> {
    if (failure !== null) throw failure
    while (out.length > 0) yield out.shift() as Uint8Array
  }
  let ended = false
  try {
    for (const item of items) {
      if (item.kind === 'directory') {
        const entry = new ZipPassThrough(item.name)
        zip.add(entry)
        entry.push(new Uint8Array(0), true)
        yield* flushed()
        continue
      }
      const extension = item.name.slice(item.name.lastIndexOf('.') + 1).toLowerCase()
      const entry = STORED.has(extension) ? new ZipPassThrough(item.name) : new ZipDeflate(item.name, { level: 6 })
      zip.add(entry)
      if (item.size === 0) entry.push(new Uint8Array(0), true)
      for await (const data of fileBytes(files, item.target, item.size, chunkBytes, signal)) {
        entry.push(data, false)
        yield* flushed()
      }
      if (item.size > 0) entry.push(new Uint8Array(0), true)
      yield* flushed()
    }
    zip.end()
    ended = true
    yield* flushed()
  } finally {
    if (!ended) zip.terminate()
  }
}

/** A pull stream over a generator: the next chunk is produced only when the reader asks for it. */
function streamOf(source: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await source.next()
      if (next.done === true) controller.close()
      else controller.enqueue(next.value)
    },
    async cancel() {
      await source.return(undefined)
    },
  })
}
