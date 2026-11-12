import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createRequire } from 'node:module'
import type Picomatch from 'picomatch'
import { FilesApi, linesOf, refusalForStatus, routeUrl, type Result } from '../src/client/api.ts'
import { FILE_ADDRESS_PATTERN, childOf, nameOf, originOf, parentOf, sessionOf, sessionPathOf, titleOf, trimSlashes } from '../src/client/paths.ts'
import { TreeModel, TreeModels, type Origin, type TreeNavigator } from '../src/client/tree.ts'
import { WatchHub, type HubOptions, type Watcher, type WatchListener, type WatchSignal, type WatchTransport } from '../src/client/watch.ts'
import { DOWNLOAD_PATH, ENTRY_PATH, WATCH_PATH, type Entry, type WatchControl, type WatchEvent } from '../src/wire.ts'

/** The POSIX build, which dsh's sidebar bundles; its types are the main build's. */
const picomatch = createRequire(import.meta.url)('picomatch/posix') as typeof Picomatch

const cwds: Record<string, string> = { s1: '/home/alice/proj' }
const cwdOf = (id: string): string | undefined => cwds[id]

describe('paths', () => {
  it('reads session addresses, relative or absolute', () => {
    assert.deepEqual(sessionPathOf('dsh-resource://file/session/s1/results/', cwdOf),
      { sessionId: 's1', path: 'results/', absolute: '/home/alice/proj/results' })
    assert.deepEqual(sessionPathOf('dsh-resource://file/session/s1/', cwdOf),
      { sessionId: 's1', path: '', absolute: '/home/alice/proj' })
    assert.deepEqual(sessionPathOf('dsh-resource://file/session/s1//tmp/out', cwdOf),
      { sessionId: 's1', path: '/tmp/out', absolute: '/tmp/out' })
    assert.equal(sessionPathOf('dsh-resource://file/session/s9/rel', cwdOf)?.absolute, undefined)
    assert.equal(sessionPathOf('dsh-resource://file/absolute/tmp/x', cwdOf), undefined)
    assert.equal(sessionPathOf('dsh-resource://changes-review/session/s1/1/2', cwdOf), undefined)
  })

  it('names tabs by their last segment, and the workspace by its own name', () => {
    assert.equal(titleOf('dsh-resource://file/session/s1/results/', cwdOf), 'results')
    assert.equal(titleOf('dsh-resource://file/session/s1/a/b%20c.txt', cwdOf), 'b c.txt')
    assert.equal(titleOf('dsh-resource://file/session/s1/', cwdOf), 'proj')
    assert.equal(titleOf('dsh-resource://file/session/s1//', cwdOf), '/')
  })

  it('claims every file address, with the sidebar\'s own glob matcher', () => {
    // As dsh's sidebar compiles a pattern containing `:`.
    const matches = picomatch(FILE_ADDRESS_PATTERN, { nocase: true, dot: true })
    for (const path of ['.', 'out', 'out/', '/tmp/x', '../up', 'a/./b', '.hidden/a', 'a%20b']) {
      assert.ok(matches(`dsh-resource://file/session/s1/${path}`), path)
    }
    assert.ok(!matches('dsh-resource://changes-review/session/s1/1/2'))
    assert.ok(!matches('sidebar://files'))
  })

  it('tells the Files page from a folder tab', () => {
    assert.deepEqual(originOf('sidebar://files', '/home/alice/proj/'), { kind: 'workspace', root: '/home/alice/proj' })
    assert.deepEqual(originOf('sidebar://files', undefined), { kind: 'workspace', root: undefined })
    assert.deepEqual(originOf('sidebar://files', ''), { kind: 'workspace', root: undefined })
    assert.deepEqual(originOf('dsh-resource://file/session/s1/out', '/home/alice/proj'),
      { kind: 'address', path: '/home/alice/proj/out', workspace: '/home/alice/proj' })
    assert.deepEqual(originOf('dsh-resource://file/session/s1/out', undefined), { kind: 'address', path: undefined, workspace: undefined })
    assert.equal(sessionOf('dsh-resource://file/session/s2//tmp', 's1'), 's2')
    assert.equal(sessionOf('sidebar://files', 's1'), 's1')
  })

  it('walks up and down', () => {
    assert.equal(trimSlashes('/a/b//'), '/a/b')
    assert.equal(trimSlashes('/'), '/')
    assert.equal(parentOf('/a/b'), '/a')
    assert.equal(parentOf('/a'), '/')
    assert.equal(parentOf('/'), undefined)
    assert.equal(childOf('/', 'a'), '/a')
    assert.equal(childOf('/a', 'b'), '/a/b')
    assert.equal(nameOf('/a/b/'), 'b')
  })
})

describe('FilesApi', () => {
  it('builds document-relative route URLs under any mount', () => {
    assert.equal(routeUrl('http://h:8080/u/alice/', ENTRY_PATH, '/home/alice/a b'),
      'http://h:8080/u/alice/api/mu-dsh-files.entry?path=%2Fhome%2Falice%2Fa+b')
    assert.equal(routeUrl('http://h/u/alice/', DOWNLOAD_PATH, '/x'), 'http://h/u/alice/api/mu-dsh-files.download?path=%2Fx')
    assert.equal(routeUrl('http://h/u/alice/', WATCH_PATH), 'http://h/u/alice/api/mu-dsh-files.watch')
  })

  it('reads a watch stream line by line, across chunks', async () => {
    const body = ['{"type":"open","stream":"s","heartbeatMs":5}\n{"type":"re', 'ady","path":"/a"}\n', '{"type":"ping"}\n']
    const api = new FilesApi(() => 'http://h/', async () => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of body) controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    })))
    const events: WatchEvent[] = []
    for await (const event of api.watchEvents(new AbortController().signal)) events.push(event)
    assert.deepEqual(events, [{ type: 'open', stream: 's', heartbeatMs: 5 }, { type: 'ready', path: '/a' }, { type: 'ping' }])
    const lines: string[] = []
    for await (const line of linesOf((async function* () { yield 'a\nb'; yield 'c\n'; yield 'unfinished' })())) lines.push(line)
    assert.deepEqual(lines, ['a', 'bc'])
  })

  it('refuses a watch stream the host refuses, and says when a stream is gone', async () => {
    const answers = [new Response('no', { status: 403 }), new Response('{}', { status: 200 }), new Response('{}', { status: 404 }), new Response('', { status: 500 })]
    const asked: Array<{ url: string; method: string; body: unknown }> = []
    const api = new FilesApi(() => 'http://h/u/a/', async (input, init) => {
      asked.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body })
      return answers.shift()!
    })
    await assert.rejects(async () => {
      for await (const event of api.watchEvents(new AbortController().signal)) void event
    }, /HTTP 403/)
    assert.equal(await api.watchControl({ stream: 's', add: ['/x'] }), true)
    assert.deepEqual(asked[1], { url: 'http://h/u/a/api/mu-dsh-files.watch', method: 'POST', body: '{"stream":"s","add":["/x"]}' })
    assert.equal(await api.watchControl({ stream: 's' }), false)
    await assert.rejects(api.watchControl({ stream: 's' }), /HTTP 500/)
  })

  it('reads refusals from the body, or from the status when there is none', async () => {
    const responses: Response[] = [
      new Response(JSON.stringify({ error: 'too-large', message: 'big' }), { status: 413 }),
      new Response(null, { status: 403 }),
      new Response(null, { status: 403, headers: { 'X-Mu-Dsh-Refusal': encodeURIComponent('cannot list "/p/ü": denied') } }),
    ]
    const api = new FilesApi(() => 'http://h/u/a/', async () => responses.shift()!)
    const signal = new AbortController().signal
    assert.deepEqual(await api.check('/x', signal), { ok: false, refusal: { error: 'too-large', message: 'big' } })
    assert.deepEqual(await api.check('/x', signal), { ok: false, refusal: { error: 'not-permitted', message: 'HTTP 403' } })
    assert.deepEqual(await api.check('/x', signal), { ok: false, refusal: { error: 'not-permitted', message: 'cannot list "/p/ü": denied' } })
    assert.equal(refusalForStatus(502), 'unavailable')
  })

  it('turns a network failure into a refusal, but not an abort', async () => {
    const api = new FilesApi(() => 'http://h/', async () => { throw new TypeError('network down') })
    assert.deepEqual(await api.entry('/x', new AbortController().signal), { ok: false, refusal: { error: 'unavailable', message: 'network down' } })
    const aborted = new AbortController()
    aborted.abort()
    await assert.rejects(api.entry('/x', aborted.signal))
  })
})

/** The host's answers, as the test scripts them; a held answer waits for the test to release it. */
class ScriptedEntries {
  readonly asked: string[] = []
  readonly answers = new Map<string, Result<Entry>>()
  readonly pending: Array<{ path: string; release: () => void }> = []
  hold = false

  readonly entry = async (path: string): Promise<Result<Entry>> => {
    this.asked.push(path)
    if (this.hold) await new Promise<void>(release => { this.pending.push({ path, release }) })
    return this.answers.get(path) ?? { ok: false, refusal: { error: 'not-found', message: `${path} missing` } }
  }
}

class ScriptedNavigator implements TreeNavigator {
  handOffs = 0
  workspaces = 0
  canHandOff = true
  handOff(): boolean {
    this.handOffs++
    return this.canHandOff
  }
  toWorkspace(): void {
    this.workspaces++
  }
}

/** Watches the test reports on. */
class ScriptedWatcher implements Watcher {
  readonly listeners = new Map<string, Set<WatchListener>>()
  watch(path: string, listener: WatchListener): () => void {
    const set = this.listeners.get(path) ?? new Set()
    set.add(listener)
    this.listeners.set(path, set)
    return () => {
      set.delete(listener)
      if (set.size === 0) this.listeners.delete(path)
    }
  }
  get watched(): string[] {
    return [...this.listeners.keys()].sort()
  }
  tell(path: string, signal: WatchSignal): void {
    for (const listener of [...this.listeners.get(path) ?? []]) listener(signal)
  }
}

const dir = (path: string, names: string[]): Result<Entry> => ({
  ok: true,
  value: { type: 'directory', path, truncated: false, entries: names.map(name => ({ name, type: name.includes('.') ? 'file' as const : 'directory' as const })) },
})

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve))
}

const workspace = (root: string | undefined): Origin => ({ kind: 'workspace', root })
const address = (path: string | undefined, root = '/home/alice/proj'): Origin => ({ kind: 'address', path, workspace: root })

function tree(): { model: TreeModel; entries: ScriptedEntries; watcher: ScriptedWatcher; navigator: ScriptedNavigator; tab: AbortController } {
  const entries = new ScriptedEntries()
  const watcher = new ScriptedWatcher()
  const tab = new AbortController()
  return { model: new TreeModel(tab.signal, { entry: entries.entry, watcher }), entries, watcher, navigator: new ScriptedNavigator(), tab }
}

describe('TreeModel', () => {
  it('shows the working directory as the Files page', async () => {
    const { model, entries, navigator } = tree()
    entries.answers.set('/home/alice/proj', dir('/home/alice/proj', ['a.txt']))
    await model.open(workspace('/home/alice/proj'), navigator)
    assert.deepEqual(model.getSnapshot().phase, { kind: 'directory', root: '/home/alice/proj' })
    assert.equal(navigator.handOffs + navigator.workspaces, 0)
  })

  it('says so for a session without a working directory, or one that is gone', async () => {
    const { model, navigator } = tree()
    await model.open(workspace(undefined), navigator)
    assert.deepEqual(model.getSnapshot().phase, { kind: 'no-workspace' })
    await model.open(workspace('/gone'), navigator)
    assert.deepEqual(model.getSnapshot().phase, { kind: 'failed', refusal: { error: 'not-found', message: '/gone missing' } })
    assert.equal(navigator.handOffs, 0)
  })

  it('keeps a linked directory', async () => {
    const { model, entries, navigator } = tree()
    entries.answers.set('/p/out', dir('/p/out', ['a.txt', 'sub']))
    await model.open(address('/p/out'), navigator)
    assert.deepEqual(model.getSnapshot().phase, { kind: 'directory', root: '/p/out' })
    assert.equal(navigator.handOffs, 0)
  })

  it('becomes the Files page when linked to the working directory', async () => {
    const { model, entries, navigator } = tree()
    entries.answers.set('/home/alice/proj', dir('/home/alice/proj', []))
    await model.open(address('/home/alice/proj', '/home/alice/proj/'), navigator)
    assert.deepEqual(model.getSnapshot().phase, { kind: 'handed-off' })
    assert.equal(navigator.workspaces, 1)
  })

  it('hands everything else to the next viewer', async () => {
    const { entries, watcher, navigator } = tree()
    entries.answers.set('/p/a.txt', { ok: true, value: { type: 'file', path: '/p/a.txt', size: 3 } })
    for (const origin of [address('/p/a.txt'), address('/p/missing'), address(undefined)]) {
      const model = new TreeModel(new AbortController().signal, { entry: entries.entry, watcher })
      await model.open(origin, navigator)
      assert.deepEqual(model.getSnapshot().phase, { kind: 'handed-off' })
    }
    assert.equal(navigator.handOffs, 3)
    assert.deepEqual(entries.asked, ['/p/a.txt', '/p/missing'])
  })

  it('keeps a file only when no other viewer takes it', async () => {
    const { model, entries, navigator } = tree()
    navigator.canHandOff = false
    entries.answers.set('/p/a.bin', { ok: true, value: { type: 'file', path: '/p/a.bin' } })
    await model.open(address('/p/a.bin'), navigator)
    assert.deepEqual(model.getSnapshot().phase, { kind: 'unviewable', path: '/p/a.bin' })
    await model.open(address('/p/missing'), navigator)
    assert.equal(model.getSnapshot().phase.kind, 'failed')
  })

  it('opens, closes, and reloads what is shown open', async () => {
    const { model, entries, navigator } = tree()
    entries.answers.set('/p', dir('/p', ['sub']))
    entries.answers.set('/p/sub', dir('/p/sub', ['x.txt']))
    await model.open(address('/p'), navigator)
    model.toggle('/p/sub')
    await settle()
    assert.deepEqual(model.getSnapshot().expanded, ['/p/sub'])
    assert.equal(model.getSnapshot().levels['/p/sub']?.kind, 'ready')
    entries.asked.length = 0
    await model.open(address('/p/'), navigator) // the same folder opened again lists it again
    await settle()
    assert.deepEqual(entries.asked.sort(), ['/p', '/p/sub'])
    model.toggle('/p/sub')
    assert.deepEqual(model.getSnapshot().expanded, [])
  })

  it('never lists one directory twice at once, and lists once more after a change during a listing', async () => {
    const { model, entries, navigator } = tree()
    entries.answers.set('/p', dir('/p', ['old.txt']))
    await model.open(address('/p'), navigator)
    entries.hold = true
    entries.asked.length = 0
    model.refresh()
    model.refresh()
    model.refresh()
    await settle()
    assert.deepEqual(entries.asked, ['/p'])
    entries.answers.set('/p', dir('/p', ['new.txt']))
    entries.pending.shift()!.release()
    await settle()
    assert.deepEqual(entries.asked, ['/p', '/p'])
    entries.pending.shift()!.release()
    await settle()
    assert.equal(entries.pending.length, 0)
    const level = model.getSnapshot().levels['/p']
    assert.ok(level?.kind === 'ready')
    assert.deepEqual(level.entries.map(e => e.name), ['new.txt'])
  })

  it('keeps what it shows when the host cannot be reached, but not when the directory is gone', async () => {
    const { model, entries, navigator } = tree()
    entries.answers.set('/p', dir('/p', ['a.txt']))
    await model.open(address('/p'), navigator)
    entries.answers.set('/p', { ok: false, refusal: { error: 'unavailable', message: 'offline' } })
    model.refresh()
    await settle()
    const kept = model.getSnapshot().levels['/p']
    assert.ok(kept?.kind === 'ready' && kept.entries.length === 1 && kept.failure?.message === 'offline')
    entries.answers.delete('/p')
    model.refresh()
    await settle()
    assert.equal(model.getSnapshot().levels['/p']?.kind, 'failed')
  })

  it('watches the directories shown open, while it is visible', async () => {
    const { model, entries, watcher, navigator } = tree()
    entries.answers.set('/p', dir('/p', ['a', 'b']))
    entries.answers.set('/p/a', dir('/p/a', ['deep']))
    entries.answers.set('/p/a/deep', dir('/p/a/deep', []))
    entries.answers.set('/p/b', dir('/p/b', []))
    await model.open(address('/p'), navigator)
    assert.deepEqual(watcher.watched, [])
    model.setVisible(true)
    assert.deepEqual(watcher.watched, ['/p'])
    model.toggle('/p/a')
    await settle()
    model.toggle('/p/a/deep')
    model.toggle('/p/b')
    await settle()
    assert.deepEqual(watcher.watched, ['/p', '/p/a', '/p/a/deep', '/p/b'])
    // Closing a directory stops watching it and what is open under it, which reopening restores.
    model.toggle('/p/a')
    assert.deepEqual(watcher.watched, ['/p', '/p/b'])
    model.toggle('/p/a')
    assert.deepEqual(watcher.watched, ['/p', '/p/a', '/p/a/deep', '/p/b'])
    model.setVisible(false)
    assert.deepEqual(watcher.watched, [])
  })

  it('lists a directory again when its watch stands or it changes, and says when changes may not show', async () => {
    const { model, entries, watcher, navigator } = tree()
    entries.answers.set('/p', dir('/p', ['a.txt']))
    await model.open(address('/p'), navigator)
    model.setVisible(true)
    entries.asked.length = 0
    watcher.tell('/p', 'ready')
    await settle()
    assert.deepEqual(entries.asked, ['/p'])
    entries.answers.set('/p', dir('/p', ['a.txt', 'b.txt']))
    watcher.tell('/p', 'change')
    await settle()
    const level = model.getSnapshot().levels['/p']
    assert.ok(level?.kind === 'ready' && level.entries.length === 2)
    watcher.tell('/p', 'lost')
    assert.equal(model.getSnapshot().stale, true)
    assert.deepEqual(entries.asked, ['/p', '/p'])
    watcher.tell('/p', 'ready')
    assert.equal(model.getSnapshot().stale, false)
    // A hidden tab watches nothing, so nothing it does not watch is stale.
    watcher.tell('/p', 'lost')
    model.setVisible(false)
    assert.equal(model.getSnapshot().stale, false)
  })

  it('watches and settles nothing once its tab has ended', async () => {
    const { model, entries, watcher, navigator, tab } = tree()
    entries.answers.set('/p', dir('/p', []))
    await model.open(address('/p'), navigator)
    model.setVisible(true)
    assert.deepEqual(watcher.watched, ['/p'])
    entries.hold = true
    model.refresh()
    tab.abort()
    assert.deepEqual(watcher.watched, [])
    entries.answers.set('/p', dir('/p', ['late.txt']))
    entries.pending.shift()!.release()
    await settle()
    const level = model.getSnapshot().levels['/p']
    assert.ok(level?.kind === 'ready' && level.entries.length === 0)
  })
})

describe('TreeModels', () => {
  it('keeps one model per tab until the tab ends', () => {
    const models = new TreeModels({ entry: new ScriptedEntries().entry, watcher: new ScriptedWatcher() })
    const tab = new AbortController()
    const model = models.get('t1', tab.signal)
    assert.equal(models.get('t1', tab.signal), model)
    tab.abort()
    const after = models.get('t1', tab.signal)
    assert.notEqual(after, model)
    assert.notEqual(models.get('t1', tab.signal), after)
  })
})

/** Watch streams the test opens and feeds. */
class ScriptedTransport implements WatchTransport {
  readonly streams: Array<{ signal: AbortSignal; push(event: WatchEvent): void; end(): void }> = []
  readonly controls: WatchControl[] = []
  known: boolean | Error = true

  events(signal: AbortSignal): AsyncIterable<WatchEvent> {
    const queue: WatchEvent[] = []
    let wake: (() => void) | undefined
    let ended = false
    const stream = {
      signal,
      push: (event: WatchEvent) => { queue.push(event); wake?.() },
      end: () => { ended = true; wake?.() },
    }
    this.streams.push(stream)
    signal.addEventListener('abort', () => { wake?.() })
    return (async function* () {
      for (;;) {
        if (signal.aborted) throw new DOMException('aborted', 'AbortError')
        const next = queue.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (ended) return
        await new Promise<void>(resolve => { wake = resolve })
      }
    })()
  }

  async control(control: WatchControl): Promise<boolean> {
    this.controls.push(control)
    if (this.known instanceof Error) throw this.known
    return this.known
  }

  /** The latest stream, opened as the host would. */
  open(name: string, heartbeatMs = 60_000): void {
    this.streams.at(-1)!.push({ type: 'open', stream: name, heartbeatMs })
  }
}

const QUICK: HubOptions = { reconnectMs: 10, reconnectMaxMs: 40, lingerMs: 30, openTimeoutMs: 1_000, missedHeartbeats: 2 }
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function heard(): { signals: WatchSignal[]; listener: WatchListener } {
  const signals: WatchSignal[] = []
  return { signals, listener: signal => { signals.push(signal) } }
}

describe('WatchHub', () => {
  it('opens one stream, asks for what is watched in one go, and passes events on', async () => {
    const transport = new ScriptedTransport()
    const hub = new WatchHub(transport, QUICK)
    const a = heard()
    const b = heard()
    hub.watch('/a', a.listener)
    hub.watch('/b', b.listener)
    await settle()
    assert.equal(transport.streams.length, 1)
    assert.deepEqual(transport.controls, [])
    transport.open('s1')
    await settle()
    assert.deepEqual(transport.controls, [{ stream: 's1', add: ['/a', '/b'], remove: [] }])
    transport.streams[0]!.push({ type: 'ready', path: '/a' })
    transport.streams[0]!.push({ type: 'change', path: '/a' })
    transport.streams[0]!.push({ type: 'change', path: '/elsewhere' })
    await settle()
    assert.deepEqual(a.signals, ['ready', 'change'])
    assert.deepEqual(b.signals, [])
    hub.dispose()
  })

  it('shares a path between listeners, telling a late one it is ready', async () => {
    const transport = new ScriptedTransport()
    const hub = new WatchHub(transport, QUICK)
    const first = heard()
    const stopFirst = hub.watch('/a', first.listener)
    transport.open('s1')
    await settle()
    transport.streams[0]!.push({ type: 'ready', path: '/a' })
    await settle()
    const late = heard()
    const stopLate = hub.watch('/a', late.listener)
    await settle()
    assert.deepEqual(late.signals, ['ready'])
    assert.equal(transport.controls.length, 1)
    stopFirst()
    await settle()
    assert.equal(transport.controls.length, 1)
    stopLate()
    await settle()
    assert.deepEqual(transport.controls.at(-1), { stream: 's1', add: [], remove: ['/a'] })
    hub.dispose()
  })

  it('sends nothing for a path watched and let go before it was asked for', async () => {
    const transport = new ScriptedTransport()
    const hub = new WatchHub(transport, QUICK)
    hub.watch('/keep', () => {})
    transport.open('s1')
    await settle()
    hub.watch('/brief', () => {})()
    await settle()
    assert.deepEqual(transport.controls, [{ stream: 's1', add: ['/keep'], remove: [] }])
    hub.dispose()
  })

  it('reports every path lost when the stream ends, and asks again on a new one', async () => {
    const transport = new ScriptedTransport()
    const hub = new WatchHub(transport, QUICK)
    const a = heard()
    hub.watch('/a', a.listener)
    hub.watch('/b', () => {})
    transport.open('s1')
    await settle()
    transport.streams[0]!.push({ type: 'ready', path: '/a' })
    await settle()
    transport.streams[0]!.end()
    await settle()
    assert.deepEqual(a.signals, ['ready', 'lost'])
    await wait(QUICK.reconnectMs * 2)
    assert.equal(transport.streams.length, 2)
    transport.open('s2')
    await settle()
    assert.deepEqual(transport.controls.at(-1), { stream: 's2', add: ['/a', '/b'], remove: [] })
    hub.dispose()
  })

  it('opens a new stream when the host no longer knows the old one', async () => {
    const transport = new ScriptedTransport()
    const hub = new WatchHub(transport, QUICK)
    hub.watch('/a', () => {})
    transport.open('s1')
    await settle()
    transport.known = false
    hub.watch('/b', () => {})
    await settle()
    assert.equal(transport.streams[0]!.signal.aborted, true)
    transport.known = true
    await wait(QUICK.reconnectMs * 2)
    transport.open('s2')
    await settle()
    assert.deepEqual(transport.controls.at(-1), { stream: 's2', add: ['/a', '/b'], remove: [] })
    hub.dispose()
  })

  it('takes a silent stream for dead', async () => {
    const transport = new ScriptedTransport()
    const hub = new WatchHub(transport, QUICK)
    const a = heard()
    hub.watch('/a', a.listener)
    transport.open('s1', 20)
    await wait(20 * QUICK.missedHeartbeats + 30)
    assert.equal(transport.streams[0]!.signal.aborted, true)
    assert.deepEqual(a.signals, ['lost'])
    hub.dispose()
  })

  it('keeps trying, more slowly, while the host refuses streams', async () => {
    const transport = new ScriptedTransport()
    const hub = new WatchHub(transport, QUICK)
    hub.watch('/a', () => {})
    for (let i = 0; i < 4; i++) {
      await settle()
      transport.streams.at(-1)!.end()
      await wait(QUICK.reconnectMaxMs + 10)
    }
    assert.ok(transport.streams.length >= 4 && transport.streams.length <= 6, `${transport.streams.length} streams`)
    hub.dispose()
  })

  it('lets the stream go a while after the last path is', async () => {
    const transport = new ScriptedTransport()
    const hub = new WatchHub(transport, QUICK)
    const stop = hub.watch('/a', () => {})
    transport.open('s1')
    await settle()
    stop()
    await wait(QUICK.lingerMs / 3)
    // Watching again within the while keeps the stream.
    const again = hub.watch('/a', () => {})
    await wait(QUICK.lingerMs * 2)
    assert.equal(transport.streams.length, 1)
    assert.equal(transport.streams[0]!.signal.aborted, false)
    again()
    await wait(QUICK.lingerMs * 2)
    assert.equal(transport.streams[0]!.signal.aborted, true)
    assert.equal(transport.streams.length, 1)
    hub.dispose()
  })
})
