/**
 * `/api/mu-dsh-files.watch`: watch streams over `ctx.fs.watch`.
 *
 * A browser page opens one stream (`GET`) and names the paths to watch on it
 * (`POST`). The host keeps each path's watch up for as long as it is asked
 * to:
 *
 * - A watch that cannot start, or breaks, is reported `lost` and tried again
 *   with backoff.
 * - dsh observes a directory through its entries, but a file or an absent path
 *   through its parent, and decides which when the watch starts. So a path
 *   that turns into a directory or stops being one, or a symlink that comes
 *   to point elsewhere, is watched again in its new form.
 * - Changes wait a moment for others to join them, and one path reports at
 *   most one change per interval. A burst of writes becomes one event, and a
 *   build churning a directory costs the browser one listing per interval.
 *
 * A stream ends when its request does (the page went away), when the host half
 * unloads, when its reader falls too far behind, or when it is the oldest of
 * too many. The browser then opens another stream and asks again.
 */

import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { refusalOf, type WatchFiles } from './files.ts'
import { headers, json, refuse } from './http.ts'
import type { WatchControl, WatchEvent } from './wire.ts'

export interface WatchOptions {
  /** Longest silence on a stream: a ping is sent this often. */
  readonly heartbeatMs: number
  /** How long a change waits for others to join it. */
  readonly settleMs: number
  /** Shortest time between two change events for one path. */
  readonly intervalMs: number
  /** Delay before the first retry of a failed watch; it doubles with each failure, up to `retryMaxMs`. */
  readonly retryMs: number
  readonly retryMaxMs: number
  /** Paths one stream may watch at once. */
  readonly maxPaths: number
  /** Streams kept at once; opening one more ends the oldest. */
  readonly maxStreams: number
  /** Bytes waiting for a reader that does not read, before its stream is ended. */
  readonly maxQueuedBytes: number
}

export const WATCH_OPTIONS: WatchOptions = {
  heartbeatMs: 20_000,
  settleMs: 100,
  intervalMs: 1_000,
  retryMs: 1_000,
  retryMaxMs: 60_000,
  maxPaths: 512,
  maxStreams: 16,
  maxQueuedBytes: 1024 ** 2,
}

/** Every stream of this host half. */
export class Watches {
  private readonly files: WatchFiles
  private readonly options: WatchOptions
  /** In the order they were opened. */
  private readonly streams = new Map<string, WatchStream>()

  constructor(files: WatchFiles, options: WatchOptions = WATCH_OPTIONS) {
    this.files = files
    this.options = options
  }

  fetch(request: Request): Response | Promise<Response> {
    return request.method === 'POST' ? this.control(request) : this.open(request)
  }

  /** `GET`: a new stream, which lasts as long as the request. */
  open(request: Request): Response {
    for (const stream of this.streams.values()) {
      if (this.streams.size < this.options.maxStreams) break
      void stream.end()
    }
    const id = randomUUID()
    const stream = new WatchStream(id, this.files, this.options, () => { this.streams.delete(id) })
    this.streams.set(id, stream)
    stream.endWith(request.signal)
    return new Response(stream.body, {
      headers: headers({
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        // Proxies such as nginx would otherwise hold events back to fill a buffer.
        'X-Accel-Buffering': 'no',
      }),
    })
  }

  /** `POST`: change what a stream watches. Removals apply before additions. */
  async control(request: Request): Promise<Response> {
    let body: unknown
    try {
      body = await request.json()
    } catch {
      return refuse(400, 'bad-request', 'the body is not JSON')
    }
    const control = parseControl(body, this.options.maxPaths)
    if (typeof control === 'string') return refuse(400, 'bad-request', control)
    const stream = this.streams.get(control.stream)
    if (stream === undefined) return refuse(404, 'not-found', 'this watch stream has ended')
    for (const path of control.remove ?? []) stream.unwatch(path)
    for (const path of control.add ?? []) stream.watch(path)
    return json({})
  }

  /** End every stream and close its watches: the host half is going away. */
  async close(): Promise<void> {
    await Promise.all([...this.streams.values()].map(stream => stream.end()))
  }
}

function parseControl(body: unknown, maxPaths: number): WatchControl | string {
  if (typeof body !== 'object' || body === null) return 'the body must be an object'
  const { stream, add, remove } = body as Record<string, unknown>
  if (typeof stream !== 'string' || stream === '') return 'stream must name a stream'
  for (const [name, paths] of [['add', add], ['remove', remove]] as const) {
    if (paths === undefined) continue
    if (!Array.isArray(paths) || paths.length > maxPaths) return `${name} must be a list of at most ${maxPaths} paths`
    for (const path of paths) {
      if (typeof path !== 'string' || path.includes('\0') || !isAbsolute(path)) return `${name} must hold absolute paths`
    }
  }
  return { stream, add: add as string[] | undefined, remove: remove as string[] | undefined }
}

const encoder = new TextEncoder()

/** One page's stream: its events, and the watches it asked for. */
class WatchStream {
  readonly id: string
  readonly body: ReadableStream<Uint8Array>
  private readonly files: WatchFiles
  private readonly options: WatchOptions
  private readonly onEnd: () => void
  private controller!: ReadableStreamDefaultController<Uint8Array>
  private readonly paths = new Map<string, PathWatch>()
  private readonly heartbeat: ReturnType<typeof setInterval>
  private ended = false
  private closing: Promise<void> | undefined

  constructor(id: string, files: WatchFiles, options: WatchOptions, onEnd: () => void) {
    this.id = id
    this.files = files
    this.options = options
    this.onEnd = onEnd
    this.body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => { this.controller = controller },
        cancel: () => this.end(),
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 }),
    )
    this.send({ type: 'open', stream: id, heartbeatMs: options.heartbeatMs })
    this.heartbeat = setInterval(() => { this.send({ type: 'ping' }) }, options.heartbeatMs)
    this.heartbeat.unref()
  }

  /** End with the request: dsh's bridge stops writing when the browser leaves, but reads until the body ends. */
  endWith(signal: AbortSignal): void {
    if (signal.aborted) void this.end()
    else signal.addEventListener('abort', () => { void this.end() }, { once: true })
  }

  send(event: WatchEvent): void {
    if (this.ended) return
    this.controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
    if ((this.controller.desiredSize ?? 0) < -this.options.maxQueuedBytes) void this.end()
  }

  watch(path: string): void {
    if (this.ended) return
    const existing = this.paths.get(path)
    if (existing !== undefined) {
      existing.confirm()
      return
    }
    if (this.paths.size >= this.options.maxPaths) {
      const message = `one page may watch at most ${this.options.maxPaths} paths at once`
      this.send({ type: 'lost', path, refusal: { error: 'too-large', message }, retrying: false })
      return
    }
    const watch = new PathWatch(path, this.files, this.options, (event) => { this.send(event) })
    this.paths.set(path, watch)
    watch.start()
  }

  unwatch(path: string): void {
    const watch = this.paths.get(path)
    if (watch === undefined) return
    this.paths.delete(path)
    void watch.stop()
  }

  /** End the stream (its reader sees the end after what is queued) and close every watch. */
  end(): Promise<void> {
    if (this.closing === undefined) {
      this.ended = true
      clearInterval(this.heartbeat)
      this.onEnd()
      try {
        this.controller.close()
      } catch {
        // Cancelled by its reader, which is why it ends.
      }
      const watches = [...this.paths.values()]
      this.paths.clear()
      this.closing = Promise.all(watches.map(watch => watch.stop())).then(() => {})
    }
    return this.closing
  }
}

/** What a watch observes: a directory's entries, or the path itself through its parent. */
type Form = 'directory' | 'other'

/** One path's watch on one stream, kept up until it is stopped. */
class PathWatch {
  private readonly path: string
  private readonly files: WatchFiles
  private readonly options: WatchOptions
  private readonly emit: (event: WatchEvent) => void
  /** The current attempt: it ends when the watch is replaced or stopped, and nothing it started may report after. */
  private attempt: AbortController | undefined
  private close: (() => Promise<void>) | undefined
  /** What the current watch was started on. */
  private watched: { readonly key: string; readonly form: Form } | undefined
  private reported: Extract<WatchEvent, { type: 'ready' | 'lost' }> | undefined
  private failures = 0
  private retry: ReturnType<typeof setTimeout> | undefined
  private settle: ReturnType<typeof setTimeout> | undefined
  private lastChange = -Infinity
  private stopped = false

  constructor(path: string, files: WatchFiles, options: WatchOptions, emit: (event: WatchEvent) => void) {
    this.path = path
    this.files = files
    this.options = options
    this.emit = emit
  }

  start(): void {
    void this.begin()
  }

  /** Asked to watch again: say where it stands. A watch still starting says so when it is done. */
  confirm(): void {
    if (this.reported !== undefined) this.emit(this.reported)
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.retry)
    await this.detach()
  }

  private async begin(): Promise<void> {
    if (this.stopped) return
    const attempt = new AbortController()
    this.attempt = attempt
    const { signal } = attempt
    try {
      const target = await this.files.resolve(this.path, { signal })
      const form = formOf(await this.files.stat(target, signal))
      const close = await this.files.watch(target, (error) => { this.changed(attempt, error) }, signal)
      if (signal.aborted) {
        await close()
        return
      }
      this.close = close
      this.watched = { key: String(target.targetKey), form }
      this.failures = 0
      this.report({ type: 'ready', path: this.path })
    } catch (error) {
      if (!signal.aborted) this.fail(attempt, error)
    }
  }

  private changed(attempt: AbortController, error?: Error): void {
    if (attempt !== this.attempt) return
    if (error !== undefined) {
      this.fail(attempt, error)
      return
    }
    if (this.settle !== undefined) return
    const wait = Math.max(this.options.settleMs, this.lastChange + this.options.intervalMs - Date.now())
    this.settle = later(wait, () => {
      this.settle = undefined
      void this.flush(attempt)
    })
  }

  private async flush(attempt: AbortController): Promise<void> {
    if (attempt !== this.attempt) return
    this.lastChange = Date.now()
    this.emit({ type: 'change', path: this.path })
    let now: { key: string; form: Form }
    try {
      const target = await this.files.resolve(this.path, { signal: attempt.signal })
      now = { key: String(target.targetKey), form: formOf(await this.files.stat(target, attempt.signal)) }
    } catch {
      // The watch still stands; the browser's listing will say what is wrong with the path.
      return
    }
    if (attempt !== this.attempt) return
    if (now.key !== this.watched?.key || now.form !== this.watched.form) {
      void this.detach()
      void this.begin()
    }
  }

  private fail(attempt: AbortController, error: unknown): void {
    if (attempt !== this.attempt) return
    void this.detach()
    this.report({ type: 'lost', path: this.path, refusal: refusalOf(error), retrying: true })
    const delay = Math.min(this.options.retryMaxMs, this.options.retryMs * 2 ** this.failures)
    this.failures += 1
    this.retry = later(delay, () => {
      this.retry = undefined
      void this.begin()
    })
  }

  /** Report a change of standing; failing again while already lost says nothing new. */
  private report(event: Extract<WatchEvent, { type: 'ready' | 'lost' }>): void {
    const repeated = event.type === 'lost' && this.reported?.type === 'lost'
    this.reported = event
    if (!repeated) this.emit(event)
  }

  /** End the current attempt, closing its watch once it has one. */
  private async detach(): Promise<void> {
    this.attempt?.abort()
    this.attempt = undefined
    this.watched = undefined
    clearTimeout(this.settle)
    this.settle = undefined
    const close = this.close
    this.close = undefined
    try {
      await close?.()
    } catch {
      // A watcher that fails to close has nothing more to report.
    }
  }
}

function formOf(info: { readonly type: string } | undefined): Form {
  return info?.type === 'directory' ? 'directory' : 'other'
}

/** A timer that does not keep the process alive by itself. */
function later(ms: number, run: () => void): ReturnType<typeof setTimeout> {
  const timer = setTimeout(run, ms)
  timer.unref()
  return timer
}

