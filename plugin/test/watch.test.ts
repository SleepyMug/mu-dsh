import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Watches, type WatchOptions } from '../src/watch.ts'
import { WATCH_PATH, type WatchControl, type WatchEvent } from '../src/wire.ts'
import { LocalFiles } from './localfiles.ts'

const FAST: WatchOptions = {
  heartbeatMs: 60_000,
  settleMs: 10,
  intervalMs: 80,
  retryMs: 20,
  retryMaxMs: 40,
  maxPaths: 4,
  maxStreams: 2,
  maxQueuedBytes: 1024 ** 2,
}

let root: string

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'mu-dsh-files-watch-'))
  await mkdir(join(root, 'out'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

const URL_ = `http://127.0.0.1${WATCH_PATH}`

/** One open stream, read event by event. */
class Reader {
  readonly lifetime = new AbortController()
  readonly response: Response
  private readonly reader: ReadableStreamDefaultReader<string>
  private buffer = ''
  /** A read outlives a `next` that timed out, so that what it brings is not lost. */
  private pending: Promise<ReadableStreamReadResult<string>> | undefined

  constructor(watches: Watches) {
    this.response = watches.open(new Request(URL_, { signal: this.lifetime.signal }))
    this.reader = this.response.body!.pipeThrough(new TextDecoderStream()).getReader()
  }

  /** The next event other than a ping; `undefined` once the stream has ended. */
  async next(timeoutMs = 2000): Promise<WatchEvent | undefined> {
    for (;;) {
      const cut = this.buffer.indexOf('\n')
      if (cut >= 0) {
        const event = JSON.parse(this.buffer.slice(0, cut)) as WatchEvent
        this.buffer = this.buffer.slice(cut + 1)
        if (event.type !== 'ping') return event
        continue
      }
      const timeout = sleep(timeoutMs).then(() => { throw new Error('no event in time') })
      this.pending ??= this.reader.read()
      const read = await Promise.race([this.pending, timeout])
      this.pending = undefined
      if (read.done) return undefined
      this.buffer += read.value
    }
  }

  /** Nothing arrives for `ms`. */
  async quiet(ms: number): Promise<void> {
    await assert.rejects(this.next(ms), /no event in time/)
  }
}

async function control(watches: Watches, body: WatchControl | unknown): Promise<Response> {
  return watches.control(new Request(URL_, { method: 'POST', body: JSON.stringify(body) }))
}

async function opened(watches: Watches): Promise<{ reader: Reader; stream: string }> {
  const reader = new Reader(watches)
  const first = await reader.next()
  assert.equal(first?.type, 'open')
  return { reader, stream: (first as Extract<WatchEvent, { type: 'open' }>).stream }
}

describe('watch route', () => {
  it('opens a stream that names itself, without buffering by proxies', async () => {
    const watches = new Watches(new LocalFiles(), FAST)
    const reader = new Reader(watches)
    assert.equal(reader.response.headers.get('Content-Type'), 'application/x-ndjson; charset=utf-8')
    assert.equal(reader.response.headers.get('X-Accel-Buffering'), 'no')
    assert.equal(reader.response.headers.get('Cache-Control'), 'private, no-store')
    const first = await reader.next()
    assert.ok(first?.type === 'open' && first.stream.length > 0 && first.heartbeatMs === FAST.heartbeatMs)
    await watches.close()
    assert.equal(await reader.next(), undefined)
  })

  it('watches a path, gathers a burst of changes into one event, and stops on request', async () => {
    const files = new LocalFiles()
    const watches = new Watches(files, FAST)
    const { reader, stream } = await opened(watches)
    const path = join(root, 'out')
    assert.equal((await control(watches, { stream, add: [path] })).status, 200)
    assert.deepEqual(await reader.next(), { type: 'ready', path })
    files.fire(path)
    files.fire(path)
    files.fire(path)
    assert.deepEqual(await reader.next(), { type: 'change', path })
    await reader.quiet(FAST.intervalMs * 2)
    assert.equal((await control(watches, { stream, remove: [path] })).status, 200)
    await sleep(5)
    assert.equal(files.watching.size, 0)
    await watches.close()
  })

  it('reports one path at most once per interval', async () => {
    const files = new LocalFiles()
    const watches = new Watches(files, FAST)
    const { reader, stream } = await opened(watches)
    const path = join(root, 'out')
    await control(watches, { stream, add: [path] })
    await reader.next()
    files.fire(path)
    await reader.next()
    const first = Date.now()
    files.fire(path)
    assert.deepEqual(await reader.next(), { type: 'change', path })
    assert.ok(Date.now() - first >= FAST.intervalMs - 15, `second change after ${Date.now() - first} ms`)
    await watches.close()
  })

  it('answers ready again when asked to watch a watched path', async () => {
    const watches = new Watches(new LocalFiles(), FAST)
    const { reader, stream } = await opened(watches)
    const path = join(root, 'out')
    await control(watches, { stream, add: [path] })
    assert.equal((await reader.next())?.type, 'ready')
    await control(watches, { stream, add: [path] })
    assert.deepEqual(await reader.next(), { type: 'ready', path })
    await watches.close()
  })

  it('reports a watch that cannot start once, and keeps trying until it does', async () => {
    const files = new LocalFiles()
    const path = join(root, 'out')
    files.unwatchable.add(path)
    const watches = new Watches(files, FAST)
    const { reader, stream } = await opened(watches)
    await control(watches, { stream, add: [path] })
    assert.deepEqual(await reader.next(), {
      type: 'lost', path, refusal: { error: 'unavailable', message: `cannot watch ${path}` }, retrying: true,
    })
    await reader.quiet(FAST.retryMaxMs * 3)
    files.unwatchable.delete(path)
    assert.deepEqual(await reader.next(), { type: 'ready', path })
    await watches.close()
  })

  it('starts a broken watch again', async () => {
    const files = new LocalFiles()
    const watches = new Watches(files, FAST)
    const { reader, stream } = await opened(watches)
    const path = join(root, 'out')
    await control(watches, { stream, add: [path] })
    await reader.next()
    files.fire(path, new Error('watcher died'))
    const lost = await reader.next()
    assert.ok(lost?.type === 'lost' && lost.retrying && lost.refusal.message === 'watcher died')
    assert.deepEqual(await reader.next(), { type: 'ready', path })
    assert.equal(files.watched.length, 2)
    await watches.close()
  })

  it('watches a path again when it stops being a directory', async () => {
    const files = new LocalFiles()
    const watches = new Watches(files, FAST)
    const { reader, stream } = await opened(watches)
    const path = join(root, 'turns')
    await mkdir(path)
    await control(watches, { stream, add: [path] })
    await reader.next()
    await rm(path, { recursive: true })
    await writeFile(path, 'now a file')
    files.fire(path)
    assert.deepEqual(await reader.next(), { type: 'change', path })
    assert.deepEqual(await reader.next(), { type: 'ready', path })
    assert.equal(files.watched.length, 2)
    // Nothing changed in form since: a change is only a change.
    files.fire(path)
    assert.deepEqual(await reader.next(), { type: 'change', path })
    await reader.quiet(50)
    assert.equal(files.watched.length, 2)
    await watches.close()
    await rm(path)
  })

  it('refuses more paths than one stream may watch', async () => {
    const watches = new Watches(new LocalFiles(), FAST)
    const { reader, stream } = await opened(watches)
    const paths = ['a', 'b', 'c', 'd', 'e'].map(name => join(root, name))
    await control(watches, { stream, add: paths.slice(0, 4) })
    for (let i = 0; i < 4; i++) assert.equal((await reader.next())?.type, 'ready')
    await control(watches, { stream, add: [paths[4]] })
    const refused = await reader.next()
    assert.ok(refused?.type === 'lost' && !refused.retrying && refused.refusal.error === 'too-large' && refused.path === paths[4])
    await watches.close()
  })

  it('refuses malformed control and unknown streams', async () => {
    const watches = new Watches(new LocalFiles(), FAST)
    const { stream } = await opened(watches)
    const bad = await watches.control(new Request(URL_, { method: 'POST', body: 'not json' }))
    assert.equal(bad.status, 400)
    assert.equal((await control(watches, { stream, add: ['relative/path'] })).status, 400)
    assert.equal((await control(watches, { stream, add: '/x' })).status, 400)
    assert.equal((await control(watches, { add: ['/x'] })).status, 400)
    assert.equal((await control(watches, { stream, add: ['/a', '/b', '/c', '/d', '/e'] })).status, 400)
    const gone = await control(watches, { stream: 'no-such-stream', add: ['/x'] })
    assert.equal(gone.status, 404)
    assert.equal(((await gone.json()) as { error: string }).error, 'not-found')
    await watches.close()
  })

  it('ends a stream, and its watches, when its request ends', async () => {
    const files = new LocalFiles()
    const watches = new Watches(files, FAST)
    const { reader, stream } = await opened(watches)
    const path = join(root, 'out')
    await control(watches, { stream, add: [path] })
    await reader.next()
    reader.lifetime.abort()
    assert.equal(await reader.next(), undefined)
    await sleep(5)
    assert.equal(files.watching.size, 0)
    assert.equal((await control(watches, { stream, add: [path] })).status, 404)
  })

  it('ends the oldest stream when too many are open', async () => {
    const watches = new Watches(new LocalFiles(), FAST)
    const first = await opened(watches)
    const second = await opened(watches)
    const third = await opened(watches)
    assert.equal(await first.reader.next(), undefined)
    assert.equal((await control(watches, { stream: first.stream, add: ['/x'] })).status, 404)
    assert.equal((await control(watches, { stream: second.stream, add: [] })).status, 200)
    assert.equal((await control(watches, { stream: third.stream, add: [] })).status, 200)
    await watches.close()
  })

  it('ends a stream whose reader falls too far behind', async () => {
    const files = new LocalFiles()
    const watches = new Watches(files, { ...FAST, maxPaths: 512, maxQueuedBytes: 2048 })
    const { reader, stream } = await opened(watches)
    // Enough events to fill the stream's 64 KiB buffer and the 2 KiB allowed past it.
    const paths = Array.from({ length: 400 }, (_, i) => join(root, `${'p'.repeat(200)}${i}`))
    await control(watches, { stream, add: paths })
    await sleep(20)
    assert.equal((await control(watches, { stream, add: [] })).status, 404)
    assert.equal(files.watching.size, 0)
    let events = 0
    while (await reader.next() !== undefined) events++
    assert.ok(events > 0 && events < paths.length, `${events} events before the end`)
  })
})
