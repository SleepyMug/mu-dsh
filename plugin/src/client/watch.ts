/**
 * The page's watches: one stream to the host for every tree in the page, and
 * the paths watched on it, each shared by every tree that shows it.
 *
 * The stream opens when the first path is wanted and closes a while after the
 * last is let go, so switching between tabs does not tear it down. When it
 * ends for any other reason (the host restarted, the network dropped, nothing
 * was heard for several heartbeats), every path is reported `lost` and a new
 * stream is opened, with backoff while that fails, on which every path is
 * asked for again; each answers `ready` once it is watched once more.
 *
 * What to watch travels as small requests beside the stream, one at a time,
 * so that an add and a remove of one path cannot overtake each other; the
 * changes made while one is on its way go together in the next.
 */

import type { WatchControl, WatchEvent } from '../wire.ts'

/** What a watched path reports to its listeners. */
export type WatchSignal = 'ready' | 'change' | 'lost'

export type WatchListener = (signal: WatchSignal) => void

export interface Watcher {
  /**
   * Watch a path until the returned function is called. The listener hears
   * `ready` once the watch stands (soon after the call, if it already does):
   * a listing read after that is current until a `change`. It hears `lost`
   * whenever changes may go unreported, until the next `ready`.
   */
  watch(path: string, listener: WatchListener): () => void
}

/** The host's watch route, as FilesApi calls it. */
export interface WatchTransport {
  events(signal: AbortSignal): AsyncIterable<WatchEvent>
  /** `false` when the host no longer has the stream. */
  control(control: WatchControl): Promise<boolean>
}

export interface HubOptions {
  /** First delay before opening a stream again after one failed to open; it doubles up to `reconnectMaxMs`. */
  readonly reconnectMs: number
  readonly reconnectMaxMs: number
  /** How long the stream stays open with nothing to watch. */
  readonly lingerMs: number
  /** How long to wait for a new stream to say it is open. */
  readonly openTimeoutMs: number
  /** Heartbeats missed in a row after which the stream is taken for dead. */
  readonly missedHeartbeats: number
}

export const HUB_OPTIONS: HubOptions = {
  reconnectMs: 1_000,
  reconnectMaxMs: 30_000,
  lingerMs: 15_000,
  openTimeoutMs: 30_000,
  missedHeartbeats: 3,
}

interface WatchedPath {
  readonly listeners: Set<WatchListener>
  ready: boolean
}

interface Connection {
  readonly lifetime: AbortController
  /** Set once the host has named the stream. */
  stream?: string
}

export class WatchHub implements Watcher {
  private readonly transport: WatchTransport
  private readonly options: HubOptions
  private readonly paths = new Map<string, WatchedPath>()
  private connection: Connection | undefined
  private running = false
  private disposed = false
  /** What to ask of the current stream next. */
  private readonly adds = new Set<string>()
  private readonly removes = new Set<string>()
  private sending = false
  private linger: ReturnType<typeof setTimeout> | undefined
  private wake: (() => void) | undefined

  constructor(transport: WatchTransport, options: HubOptions = HUB_OPTIONS) {
    this.transport = transport
    this.options = options
  }

  watch(path: string, listener: WatchListener): () => void {
    if (this.disposed) return () => {}
    let watched = this.paths.get(path)
    if (watched === undefined) {
      watched = { listeners: new Set(), ready: false }
      this.paths.set(path, watched)
      this.want(path, true)
    } else if (watched.ready) {
      const known = watched
      queueMicrotask(() => {
        if (known.ready && known.listeners.has(listener)) listener('ready')
      })
    }
    const entry = watched
    entry.listeners.add(listener)
    clearTimeout(this.linger)
    this.linger = undefined
    this.run()
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      entry.listeners.delete(listener)
      if (entry.listeners.size > 0 || this.paths.get(path) !== entry) return
      this.paths.delete(path)
      this.want(path, false)
      if (this.paths.size === 0) {
        this.linger = setTimeout(() => {
          if (this.paths.size === 0) this.connection?.lifetime.abort()
        }, this.options.lingerMs)
      }
    }
  }

  /** Stop everything: the plugin is going away. */
  dispose(): void {
    this.disposed = true
    this.paths.clear()
    clearTimeout(this.linger)
    this.connection?.lifetime.abort()
    this.wake?.()
  }

  private want(path: string, add: boolean): void {
    if (add) {
      this.removes.delete(path)
      this.adds.add(path)
    } else if (!this.adds.delete(path)) {
      this.removes.add(path)
    }
    void this.send()
  }

  /** Send what changed, one request at a time, for as long as there is something to send and a stream to send it to. */
  private async send(): Promise<void> {
    if (this.sending) return
    this.sending = true
    try {
      // Let the caller finish what it is doing, so that its changes travel together.
      await Promise.resolve()
      for (;;) {
        const connection = this.connection
        const stream = connection?.stream
        if (connection === undefined || stream === undefined || (this.adds.size === 0 && this.removes.size === 0)) return
        const control: WatchControl = { stream, add: [...this.adds], remove: [...this.removes] }
        this.adds.clear()
        this.removes.clear()
        let known: boolean
        try {
          known = await this.transport.control(control)
        } catch {
          known = false
        }
        if (!known) {
          // The stream is unusable: ending it opens another, on which everything is asked for again.
          connection.lifetime.abort()
          return
        }
      }
    } finally {
      this.sending = false
    }
  }

  private run(): void {
    if (this.running || this.disposed || this.paths.size === 0) return
    this.running = true
    void this.connect().finally(() => {
      this.running = false
      // A path wanted just as the last stream was let go.
      this.run()
    })
  }

  private async connect(): Promise<void> {
    let failures = 0
    while (!this.disposed && this.paths.size > 0) {
      const connection: Connection = { lifetime: new AbortController() }
      this.connection = connection
      let opened = false
      try {
        await this.follow(connection, () => { opened = true })
      } catch {
        // Refused, broken, or ended on purpose; all the same from here.
      }
      connection.lifetime.abort()
      this.connection = undefined
      this.adds.clear()
      this.removes.clear()
      this.lose()
      if (this.disposed || this.paths.size === 0) return
      failures = opened ? 0 : failures + 1
      await this.pause(Math.min(this.options.reconnectMaxMs, this.options.reconnectMs * 2 ** Math.max(0, failures - 1)))
    }
  }

  /** Read one stream until it ends, hearing something at least every few heartbeats. */
  private async follow(connection: Connection, opened: () => void): Promise<void> {
    const { lifetime } = connection
    let silence: ReturnType<typeof setTimeout> | undefined
    const expect = (ms: number): void => {
      clearTimeout(silence)
      silence = setTimeout(() => { lifetime.abort() }, ms)
    }
    expect(this.options.openTimeoutMs)
    let patience = this.options.openTimeoutMs
    try {
      for await (const event of this.transport.events(lifetime.signal)) {
        if (event.type === 'open') {
          connection.stream = event.stream
          patience = event.heartbeatMs * this.options.missedHeartbeats
          opened()
          // A new stream watches nothing yet.
          this.removes.clear()
          for (const path of this.paths.keys()) this.adds.add(path)
          void this.send()
        } else if (event.type !== 'ping') {
          this.dispatch(event.path, event.type)
        }
        expect(patience)
      }
    } finally {
      clearTimeout(silence)
    }
  }

  private dispatch(path: string, signal: WatchSignal): void {
    const watched = this.paths.get(path)
    if (watched === undefined) return
    if (signal === 'ready') watched.ready = true
    else if (signal === 'lost') watched.ready = false
    for (const listener of [...watched.listeners]) listener(signal)
  }

  /** The stream ended: nothing is watched until a new one says otherwise. */
  private lose(): void {
    for (const path of [...this.paths.keys()]) this.dispatch(path, 'lost')
  }

  private pause(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        this.wake = undefined
        resolve()
      }
      const timer = setTimeout(done, ms)
      this.wake = done
    })
  }
}
