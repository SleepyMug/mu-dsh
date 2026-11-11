import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { FilesApi, refusalForStatus, routeUrl, type Result } from '../src/client/api.ts'
import { FolderModel, FolderModels, type FolderHost } from '../src/client/folder.ts'
import { childOf, nameOf, parentOf, sessionPathOf, titleOf, trimSlashes } from '../src/client/paths.ts'
import { DOWNLOAD_PATH, ENTRY_PATH, type Entry } from '../src/wire.ts'

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

/** A host whose answers the test scripts, recording what was asked. */
class ScriptedHost implements FolderHost {
  readonly asked: string[] = []
  handOffs = 0
  canHandOff = true
  readonly answers = new Map<string, Result<Entry>>()
  pending: Array<{ path: string; resolve: () => void }> = []
  hold = false

  async entry(path: string): Promise<Result<Entry>> {
    this.asked.push(path)
    if (this.hold) await new Promise<void>(resolve => { this.pending.push({ path, resolve }) })
    return this.answers.get(path) ?? { ok: false, refusal: { error: 'not-found', message: `${path} missing` } }
  }

  handOff(): boolean {
    this.handOffs++
    return this.canHandOff
  }
}

const dir = (path: string, names: string[]): Result<Entry> => ({
  ok: true,
  value: { type: 'directory', path, truncated: false, entries: names.map(name => ({ name, type: name.includes('.') ? 'file' as const : 'directory' as const })) },
})

describe('FolderModel', () => {
  it('stays for a directory', async () => {
    const host = new ScriptedHost()
    host.answers.set('/p/out', dir('/p/out', ['a.txt', 'sub']))
    const model = new FolderModel(new AbortController().signal)
    await model.open('/p/out', host)
    assert.deepEqual(model.getSnapshot().phase, { kind: 'directory', root: '/p/out' })
    assert.equal(host.handOffs, 0)
  })

  it('hands everything else to the next viewer', async () => {
    const host = new ScriptedHost()
    host.answers.set('/p/a.txt', { ok: true, value: { type: 'file', path: '/p/a.txt', size: 3 } })
    for (const path of ['/p/a.txt', '/p/missing']) {
      const model = new FolderModel(new AbortController().signal)
      await model.open(path, host)
      assert.deepEqual(model.getSnapshot().phase, { kind: 'handed-off' })
    }
    const unknown = new FolderModel(new AbortController().signal)
    await unknown.open(undefined, host)
    assert.deepEqual(unknown.getSnapshot().phase, { kind: 'handed-off' })
    assert.equal(host.handOffs, 3)
    assert.deepEqual(host.asked, ['/p/a.txt', '/p/missing'])
  })

  it('keeps a file only when no other viewer takes it', async () => {
    const host = new ScriptedHost()
    host.canHandOff = false
    host.answers.set('/p/a.bin', { ok: true, value: { type: 'file', path: '/p/a.bin' } })
    const model = new FolderModel(new AbortController().signal)
    await model.open('/p/a.bin', host)
    assert.deepEqual(model.getSnapshot().phase, { kind: 'unviewable', path: '/p/a.bin' })
    await model.open('/p/missing', host)
    assert.equal(model.getSnapshot().phase.kind, 'failed')
  })

  it('expands, collapses, and reloads what is expanded', async () => {
    const host = new ScriptedHost()
    host.answers.set('/p', dir('/p', ['sub']))
    host.answers.set('/p/sub', dir('/p/sub', ['x.txt']))
    const model = new FolderModel(new AbortController().signal)
    await model.open('/p', host)
    await model.toggle('/p/sub', host)
    assert.deepEqual(model.getSnapshot().expanded, ['/p/sub'])
    assert.equal(model.getSnapshot().levels['/p/sub']?.kind, 'ready')
    host.asked.length = 0
    await model.open('/p/', host) // the same folder opened again lists it again
    assert.deepEqual(host.asked.sort(), ['/p', '/p/sub'])
    await model.toggle('/p/sub', host)
    assert.deepEqual(model.getSnapshot().expanded, [])
  })

  it('lets only the latest listing of a path settle it', async () => {
    const host = new ScriptedHost()
    host.answers.set('/p', dir('/p', ['old.txt']))
    const model = new FolderModel(new AbortController().signal)
    await model.open('/p', host)
    host.hold = true
    const first = model.refresh(host)
    host.answers.set('/p', dir('/p', ['new.txt']))
    const second = model.refresh(host)
    const [older, newer] = host.pending
    newer!.resolve()
    await second
    older!.resolve()
    await first
    const level = model.getSnapshot().levels['/p']
    assert.ok(level?.kind === 'ready')
    assert.deepEqual(level.entries.map(e => e.name), ['new.txt'])
  })

  it('settles nothing once its tab has ended', async () => {
    const host = new ScriptedHost()
    host.answers.set('/p', dir('/p', []))
    host.hold = true
    const tab = new AbortController()
    const model = new FolderModel(tab.signal)
    const opened = model.open('/p', host)
    tab.abort()
    host.pending[0]!.resolve()
    await opened
    assert.deepEqual(model.getSnapshot().phase, { kind: 'probing' })
  })
})

describe('FolderModels', () => {
  it('keeps one model per tab until the tab ends', () => {
    const models = new FolderModels()
    const tab = new AbortController()
    const model = models.get('t1', tab.signal)
    assert.equal(models.get('t1', tab.signal), model)
    tab.abort()
    assert.equal(models.peek('t1'), undefined)
    assert.notEqual(models.get('t1', tab.signal), model)
    assert.equal(models.peek('t1'), undefined)
  })
})
