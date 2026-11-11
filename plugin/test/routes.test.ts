import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { unzipSync } from 'fflate'
import { download, LIMITS } from '../src/download.ts'
import { entry } from '../src/entry.ts'
import { attachment } from '../src/http.ts'
import { DOWNLOAD_PATH, ENTRY_PATH, type Entry } from '../src/wire.ts'
import { LocalFiles } from './localfiles.ts'

let root: string

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'mu-dsh-files-'))
  await mkdir(join(root, 'out', 'nested', 'deeper'), { recursive: true })
  await mkdir(join(root, 'out', 'empty'))
  await writeFile(join(root, 'out', 'a.txt'), 'alpha\n')
  await writeFile(join(root, 'out', 'nested', 'b.bin'), new Uint8Array(3000).map((_, i) => i % 251))
  await writeFile(join(root, 'out', 'nested', 'deeper', 'c.png'), 'not really a png')
  await writeFile(join(root, 'out', 'größe 1.txt'), 'unicode name')
  await symlink(join(root, 'out'), join(root, 'out', 'nested', 'loop'))
  await symlink(join(root, 'out', 'a.txt'), join(root, 'out', 'a-link.txt'))
})

after(async () => {
  await rm(root, { recursive: true, force: true })
})

function get(route: string, path: string | undefined, method = 'GET'): Request {
  const url = new URL(`http://127.0.0.1${route}`)
  if (path !== undefined) url.searchParams.set('path', path)
  return new Request(url, { method })
}

describe('entry route', () => {
  it('lists a directory', async () => {
    const response = await entry(new LocalFiles(), get(ENTRY_PATH, join(root, 'out')))
    assert.equal(response.status, 200)
    const body = await response.json() as Entry
    assert.equal(body.type, 'directory')
    if (body.type !== 'directory') return
    assert.equal(body.path, join(root, 'out'))
    assert.equal(body.truncated, false)
    assert.deepEqual(body.entries.map(e => [e.name, e.type]), [
      ['a-link.txt', 'file'], ['a.txt', 'file'], ['empty', 'directory'], ['größe 1.txt', 'file'], ['nested', 'directory'],
    ])
    assert.equal(body.entries.find(e => e.name === 'a.txt')?.size, 6)
  })

  it('marks a listing cut at the limit', async () => {
    const response = await entry(new LocalFiles(), get(ENTRY_PATH, join(root, 'out')), 2)
    const body = await response.json() as Entry
    assert.ok(body.type === 'directory' && body.truncated && body.entries.length === 2)
  })

  it('reports a file without reading it', async () => {
    const files = new LocalFiles()
    const response = await entry(files, get(ENTRY_PATH, join(root, 'out', 'a.txt')))
    assert.deepEqual(await response.json(), { type: 'file', path: join(root, 'out', 'a.txt'), size: 6 })
    assert.equal(files.reads.length, 0)
  })

  it('refuses a path under a directory dsh may not search', async () => {
    const locked = join(root, 'locked')
    await mkdir(join(locked, 'inner'), { recursive: true })
    await writeFile(join(locked, 'inner', 's.txt'), 'secret')
    await chmod(locked, 0)
    try {
      const response = await entry(new LocalFiles(), get(ENTRY_PATH, join(locked, 'inner', 's.txt')))
      assert.equal(response.status, 403)
      assert.equal((await response.json() as { error: string }).error, 'not-permitted')
      const head = await download(new LocalFiles(), get(DOWNLOAD_PATH, join(locked, 'inner'), 'HEAD'))
      assert.equal(head.status, 403)
    } finally {
      await chmod(locked, 0o755)
    }
  })

  it('refuses missing, relative, and absent paths', async () => {
    const missing = await entry(new LocalFiles(), get(ENTRY_PATH, join(root, 'nope')))
    assert.equal(missing.status, 404)
    assert.equal((await missing.json() as { error: string }).error, 'not-found')
    assert.equal((await entry(new LocalFiles(), get(ENTRY_PATH, 'out/a.txt'))).status, 400)
    assert.equal((await entry(new LocalFiles(), get(ENTRY_PATH, undefined))).status, 400)
  })
})

describe('download route', () => {
  it('sends a file as an attachment, in chunks', async () => {
    const files = new LocalFiles()
    const response = await download(files, get(DOWNLOAD_PATH, join(root, 'out', 'nested', 'b.bin')), { ...LIMITS, chunkBytes: 1024 })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-length'), '3000')
    assert.equal(response.headers.get('content-type'), 'application/octet-stream')
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment; filename="b\.bin"/)
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.equal(bytes.length, 3000)
    assert.equal(bytes[2999], 2999 % 251)
    assert.deepEqual(files.reads.map(r => r.length), [1024, 1024, 952])
  })

  it('answers HEAD with the headers alone', async () => {
    const files = new LocalFiles()
    const response = await download(files, get(DOWNLOAD_PATH, join(root, 'out', 'a.txt'), 'HEAD'))
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-length'), '6')
    assert.equal(response.body, null)
    assert.equal(files.reads.length, 0)
  })

  it('archives a directory under its own name, entering each directory once', async () => {
    const response = await download(new LocalFiles(), get(DOWNLOAD_PATH, join(root, 'out')), { ...LIMITS, chunkBytes: 1000 })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'application/zip')
    assert.match(response.headers.get('content-disposition') ?? '', /filename="out\.zip"/)
    const archive = unzipSync(new Uint8Array(await response.arrayBuffer()))
    assert.deepEqual(Object.keys(archive).sort(), [
      'out/a-link.txt', 'out/a.txt', 'out/empty/', 'out/größe 1.txt', 'out/nested/b.bin', 'out/nested/deeper/c.png',
    ])
    assert.equal(new TextDecoder().decode(archive['out/a.txt']), 'alpha\n')
    assert.equal(new TextDecoder().decode(archive['out/a-link.txt']), 'alpha\n')
    assert.equal(archive['out/nested/b.bin']?.length, 3000)
    assert.equal(archive['out/nested/b.bin']?.[1234], 1234 % 251)
  })

  it('refuses an archive over the limits before sending anything', async () => {
    const files = new LocalFiles()
    const entries = await download(files, get(DOWNLOAD_PATH, join(root, 'out')), { ...LIMITS, maxEntries: 3 })
    assert.equal(entries.status, 413)
    assert.equal((await entries.json() as { error: string }).error, 'too-large')
    const bytes = await download(files, get(DOWNLOAD_PATH, join(root, 'out'), 'HEAD'), { ...LIMITS, maxBytes: 100 })
    assert.equal(bytes.status, 413)
    assert.equal(bytes.body, null)
    assert.equal(files.reads.length, 0)
  })

  it('refuses an archive with an unreadable directory, naming it even to HEAD', async () => {
    const files = new LocalFiles()
    files.denied.add(join(root, 'out', 'nested'))
    const response = await download(files, get(DOWNLOAD_PATH, join(root, 'out')))
    assert.equal(response.status, 403)
    assert.match((await response.json() as { message: string }).message, /nested/)
    const head = await download(files, get(DOWNLOAD_PATH, join(root, 'out'), 'HEAD'))
    assert.equal(head.status, 403)
    assert.equal(head.body, null)
    assert.match(decodeURIComponent(head.headers.get('x-mu-dsh-refusal') ?? ''), /cannot list ".*nested": permission denied/)
  })

  it('fails the stream when a file shrinks while it is sent', async () => {
    const path = join(root, 'shrinking.bin')
    await writeFile(path, new Uint8Array(4096))
    const response = await download(new LocalFiles(), get(DOWNLOAD_PATH, path), { ...LIMITS, chunkBytes: 1024 })
    const reader = response.body!.getReader()
    await reader.read()
    await truncate(path, 1500)
    await assert.rejects(async () => {
      for (;;) if ((await reader.read()).done) break
    }, /shrank/)
  })

  it('refuses a missing path', async () => {
    const response = await download(new LocalFiles(), get(DOWNLOAD_PATH, join(root, 'nope')))
    assert.equal(response.status, 404)
  })
})

describe('attachment', () => {
  it('gives an ASCII fallback and the exact name', () => {
    assert.equal(attachment('größe "1".txt'), `attachment; filename="gr__e _1_.txt"; filename*=UTF-8''gr%C3%B6%C3%9Fe%20%221%22.txt`)
    assert.equal(attachment("it's (x)*.zip"), `attachment; filename="it's (x)*.zip"; filename*=UTF-8''it%27s%20%28x%29%2A.zip`)
  })
})
