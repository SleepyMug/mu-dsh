import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo, type Server as NetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createApp } from '../src/app.ts'
import { createSession, parseCookies, readSession, stripCookie } from '../src/auth.ts'
import { SocketControl } from '../src/control.ts'
import type { Logger } from '../src/log.ts'
import { rewriteLocation, rewriteSetCookie } from '../src/proxy.ts'
import { upstreamUrl } from '../src/relay.ts'
import { MemoryState, type GatewayState } from '../src/state.ts'

/** Collects log lines instead of printing them. */
function memoryLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  return { lines, info: (m) => lines.push(m), error: (m) => lines.push(m) }
}

/** Stands in for control/controlserver.py: one password per listed user, changeable;
 * workspace requests are recorded in `actions`. */
function fakeControlServer(path: string, users: string[], password: string, actions: string[] = []): Promise<NetServer> {
  const passwords = new Map(users.map((u) => [u, password]))
  const server = createNetServer((socket) => {
    let buffer = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (!buffer.includes('\n')) return
      const req = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as {
        op: string
        user: string
        password: string
        new_password?: string
        action?: string
      }
      const ok = passwords.get(req.user) === req.password
      if (req.op === 'workspace') {
        actions.push(`${req.user}:${req.action}`)
        socket.end(JSON.stringify({ ok: true }) + '\n')
      } else if (req.op === 'change_password') {
        if (ok) passwords.set(req.user, req.new_password ?? '')
        socket.end(JSON.stringify(ok ? { ok } : { ok, error: 'The current password is wrong.' }) + '\n')
      } else {
        socket.end(JSON.stringify({ ok }) + '\n')
      }
    })
  })
  return new Promise((resolve) => server.listen(path, () => resolve(server)))
}

describe('auth', () => {
  it('round-trips sessions and rejects tampering and expiry', () => {
    const value = createSession('alice', 's3cret', 60, 1_000_000)
    assert.equal(readSession(value, 's3cret', 1_000_000), 'alice')
    assert.equal(readSession(value, 'other', 1_000_000), undefined)
    assert.equal(readSession(value.replace(/^[^.]+/, Buffer.from('bob').toString('base64url')), 's3cret', 1_000_000), undefined)
    assert.equal(readSession(value, 's3cret', 1_000_000 + 61_000), undefined)
    assert.equal(readSession('garbage', 's3cret'), undefined)
  })

  it('parses and strips cookies', () => {
    assert.deepEqual([...parseCookies('a=1; mu_dsh_session=x; b=2')], [['a', '1'], ['mu_dsh_session', 'x'], ['b', '2']])
    assert.equal(stripCookie('a=1; mu_dsh_session=x; b=2', 'mu_dsh_session'), 'a=1; b=2')
    assert.equal(stripCookie('mu_dsh_session=x', 'mu_dsh_session'), undefined)
  })

  it('asks the control plane socket and treats failures as refusals', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mu-dsh-test-'))
    const path = join(dir, 'control.sock')
    const log = memoryLogger()
    const state = new MemoryState({ control_socket: path, users: {} } as unknown as GatewayState)
    const verifier = new SocketControl(state, log)
    const actions: string[] = []
    const server = await fakeControlServer(path, ['alice'], 'secret', actions)
    try {
      assert.equal(await verifier.verify('alice', 'secret'), true)
      assert.equal(await verifier.verify('alice', 'wrong'), false)
      assert.equal(await verifier.verify('mallory', 'secret'), false)
      assert.equal(await verifier.change('alice', 'wrong', 'next-secret'), 'The current password is wrong.')
      assert.equal(await verifier.change('alice', 'secret', 'next-secret'), undefined)
      assert.equal(await verifier.verify('alice', 'next-secret'), true)
      assert.equal(await verifier.workspace('alice', 'recover'), undefined)
      assert.deepEqual(actions, ['alice:recover'])
      server.close()
      assert.equal(await verifier.verify('alice', 'secret'), false)
      assert.equal(await verifier.workspace('alice', 'restart'), 'The service did not respond.')
      assert.match(log.lines.join('\n'), /control socket failed/)
    } finally {
      server.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('proxy helpers', () => {
  it('moves dsh cookies under the user prefix', () => {
    assert.equal(
      rewriteSetCookie('dsh_x=v; Max-Age=10; Path=/; HttpOnly; SameSite=Strict', '/u/alice'),
      'dsh_x=v; Max-Age=10; Path=/u/alice/; HttpOnly; SameSite=Strict',
    )
    assert.equal(rewriteSetCookie('k=v; HttpOnly', '/u/bob'), 'k=v; HttpOnly; Path=/u/bob/')
    assert.equal(rewriteSetCookie('k=v; path=/api', '/u/bob'), 'k=v; Path=/u/bob/api')
  })

  it('keeps absolute-path redirects inside the prefix', () => {
    assert.equal(rewriteLocation('./', '/u/alice'), './')
    assert.equal(rewriteLocation('/x?y', '/u/alice'), '/u/alice/x?y')
    assert.equal(rewriteLocation('//evil/', '/u/alice'), '//evil/')
    assert.equal(rewriteLocation('https://a/b', '/u/alice'), 'https://a/b')
  })

  it('maps relay paths onto the upstream base', () => {
    assert.equal(upstreamUrl('https://llm.corp/v1', '/v1/chat/completions')?.href, 'https://llm.corp/v1/chat/completions')
    assert.equal(upstreamUrl('http://h:9/openai/v1/', '/v1/models?x=1')?.href, 'http://h:9/openai/v1/models?x=1')
    assert.equal(upstreamUrl('http://h/v1', '/v2/models'), undefined)
    assert.equal(upstreamUrl('http://h/v1', '/v1x'), undefined)
  })
})

// --- integration: gateway + relay against stand-ins for dsh and the upstream LLM ---

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

interface Reply {
  status: number
  headers: IncomingMessage['headers']
  body: string
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: 'gw.test:8080', ...headers } }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (data += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** Mimics dsh's index authentication: token exchange -> cookie -> 200. */
function fakeDsh(token: string): Server {
  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const cookie = parseCookies(req.headers.cookie).get('dsh_session')
    if (url.pathname === '/' && url.searchParams.get('token') === token) {
      res.writeHead(303, { location: './', 'set-cookie': 'dsh_session=ok; Max-Age=60; Path=/; HttpOnly; SameSite=Strict' })
      res.end()
      return
    }
    if (cookie !== 'ok') {
      res.writeHead(401)
      res.end('unauthorized')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(`dsh ${url.pathname} host=${req.headers.host} gwcookie=${req.headers.cookie?.includes('mu_dsh_session') ?? false}`)
  })
}

describe('gateway and relay', () => {
  const servers: Server[] = []
  let gwPort = 0
  let relayPort = 0
  const seen: { auth?: string; path?: string }[] = []
  const log = memoryLogger()
  const dir = mkdtempSync(join(tmpdir(), 'mu-dsh-test-'))
  const actions: string[] = []
  let control: NetServer
  let memory: MemoryState

  before(async () => {
    control = await fakeControlServer(join(dir, 'control.sock'), ['alice', 'bob'], 'secret', actions)
    const dsh = fakeDsh('tok123')
    const upstream = createServer((req, res) => {
      seen.push({ auth: req.headers.authorization, path: req.url })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
    servers.push(dsh, upstream)
    const dshPort = await listen(dsh)
    const upstreamPort = await listen(upstream)
    const state: GatewayState = {
      version: 1,
      gateway: { listen_host: '127.0.0.1', listen_port: 0, public_url: 'http://gw.test:8080', session_max_age_days: 1 },
      session_secret: 'test-secret',
      control_socket: join(dir, 'control.sock'),
      relay: { listen_host: '127.0.0.1', listen_port: 0, upstream: `http://127.0.0.1:${upstreamPort}/v1`, api_key: 'REAL' },
      users: {
        alice: { port: dshPort, llm_key: 'key-alice', enabled: true, up: true, token: 'tok123', error: null, mode: 'normal' },
        bob: { port: 1, llm_key: 'key-bob', enabled: false, up: false, token: null, error: null, mode: 'normal' },
      },
    }
    memory = new MemoryState(state)
    const app = createApp({ state: memory, log })
    servers.push(app.gateway, app.relay)
    gwPort = await listen(app.gateway)
    relayPort = await listen(app.relay)
  })

  after(() => {
    for (const s of servers) {
      s.closeAllConnections()
      s.close()
    }
    control.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('signs in and walks through the dsh token exchange', async () => {
    const bad = await call(gwPort, 'POST', '/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'username=alice&password=nope')
    assert.equal(bad.status, 401)

    const disabled = await call(gwPort, 'POST', '/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'username=bob&password=secret')
    assert.equal(disabled.status, 401)

    const ok = await call(gwPort, 'POST', '/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'username=alice&password=secret')
    assert.equal(ok.status, 303)
    assert.equal(ok.headers.location, '/u/alice/')
    const session = String(ok.headers['set-cookie']?.[0]).split(';')[0]

    const anon = await call(gwPort, 'GET', '/u/alice/')
    assert.equal(anon.status, 303)
    assert.match(String(anon.headers.location), /^\/login\?next=/)

    const index = await call(gwPort, 'GET', '/u/alice/', { cookie: session })
    assert.equal(index.status, 302)
    assert.equal(index.headers.location, '/u/alice/?token=tok123')

    const exchange = await call(gwPort, 'GET', '/u/alice/?token=tok123', { cookie: session })
    assert.equal(exchange.status, 303)
    assert.equal(exchange.headers.location, './')
    const dshCookie = String(exchange.headers['set-cookie']?.[0])
    assert.match(dshCookie, /Path=\/u\/alice\//)

    const page = await call(gwPort, 'GET', '/u/alice/api/thing', { cookie: `${session}; ${dshCookie.split(';')[0]}` })
    assert.equal(page.status, 200)
    assert.equal(page.body, 'dsh /api/thing host=gw.test:8080 gwcookie=false')

    const other = await call(gwPort, 'GET', '/u/bob/', { cookie: session })
    assert.equal(other.status, 403)

    const slash = await call(gwPort, 'GET', '/u/alice', { cookie: session })
    assert.equal(slash.status, 301)
    assert.equal(slash.headers.location, '/u/alice/')
    assert.deepEqual(
      log.lines.filter((l) => l.startsWith('gateway:')),
      ['gateway: failed login for "alice"', 'gateway: failed login for "bob"', 'gateway: alice signed in'],
    )
  })

  it('serves a portal and lets users change their password', async () => {
    const b = await call(gwPort, 'POST', '/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'username=bob&password=secret')
    assert.equal(b.status, 401, 'bob is disabled')
    const login = await call(gwPort, 'POST', '/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'username=alice&password=secret')
    const session = String(login.headers['set-cookie']?.[0]).split(';')[0]
    const form = { 'content-type': 'application/x-www-form-urlencoded', cookie: session }

    const portal = await call(gwPort, 'GET', '/', { cookie: session })
    assert.equal(portal.status, 200)
    assert.match(portal.body, /href="\/u\/alice\/"/)
    assert.match(portal.body, /href="\/account\/password"/)
    assert.equal((await call(gwPort, 'GET', '/account/password')).status, 303, 'sign-in required')
    assert.equal((await call(gwPort, 'GET', '/account/password', { cookie: session })).status, 200)

    const mismatch = await call(gwPort, 'POST', '/account/password', form, 'current=secret&new=one-thing&repeat=another')
    assert.equal(mismatch.status, 400)
    assert.match(mismatch.body, /do not match/)
    const wrong = await call(gwPort, 'POST', '/account/password', form, 'current=nope&new=new-secret&repeat=new-secret')
    assert.equal(wrong.status, 400)
    assert.match(wrong.body, /current password is wrong/)
    const done = await call(gwPort, 'POST', '/account/password', form, 'current=secret&new=new-secret&repeat=new-secret')
    assert.equal(done.status, 303)
    assert.equal(done.headers.location, '/?changed=password')
    assert.match((await call(gwPort, 'GET', '/?changed=password', { cookie: session })).body, /password was changed/)

    const relogin = (pw: string) =>
      call(gwPort, 'POST', '/login', { 'content-type': 'application/x-www-form-urlencoded' }, `username=alice&password=${pw}`)
    assert.equal((await relogin('secret')).status, 401)
    assert.equal((await relogin('new-secret')).status, 303)
  })

  it('restarts the workspace, enters and leaves recovery mode, and resets settings', async () => {
    const login = await call(gwPort, 'POST', '/login', { 'content-type': 'application/x-www-form-urlencoded' }, 'username=alice&password=new-secret')
    const session = String(login.headers['set-cookie']?.[0]).split(';')[0]
    const form = { 'content-type': 'application/x-www-form-urlencoded', cookie: session }
    const setAlice = (patch: Partial<GatewayState['users'][string]>) => {
      const current = memory.current
      memory.set({ ...current, users: { ...current.users, alice: { ...current.users.alice, ...patch } } })
    }

    const portal = await call(gwPort, 'GET', '/', { cookie: session })
    assert.match(portal.body, /value="restart"/)
    assert.match(portal.body, /value="recover"/)
    assert.match(portal.body, /href="\/account\/reset"/)
    assert.doesNotMatch(portal.body, /Recovery mode\./)

    assert.equal((await call(gwPort, 'POST', '/account/workspace', { 'content-type': 'application/x-www-form-urlencoded' }, 'action=restart')).headers.location, '/login')
    assert.equal((await call(gwPort, 'GET', '/account/workspace', { cookie: session })).status, 303, 'GET does nothing')
    assert.equal((await call(gwPort, 'POST', '/account/workspace', form, 'action=format-disk')).status, 400)
    assert.deepEqual(actions, [])

    for (const action of ['recover', 'restart', 'reset']) {
      const done = await call(gwPort, 'POST', '/account/workspace', form, `action=${action}`)
      assert.equal(done.status, 303)
      assert.equal(done.headers.location, '/u/alice/')
    }
    assert.deepEqual(actions, ['alice:recover', 'alice:restart', 'alice:reset'])
    assert.match((await call(gwPort, 'GET', '/account/reset', { cookie: session })).body, /value="reset"/)

    setAlice({ mode: 'recovery' })
    const inRecovery = await call(gwPort, 'GET', '/', { cookie: session })
    assert.match(inRecovery.body, /Recovery mode\./)
    assert.match(inRecovery.body, /Leave recovery mode/)
    assert.doesNotMatch(inRecovery.body, /value="recover"/)

    setAlice({ up: false, token: null, error: 'exited with status 1 after 2s:\nError: dsh: failed to parse overlay', mode: 'normal' })
    const starting = await call(gwPort, 'GET', '/u/alice/', { cookie: session, accept: 'text/html' })
    assert.equal(starting.status, 503)
    assert.match(starting.body, /failed to parse overlay/)
    assert.match(starting.body, /Retry now/)
    assert.match(starting.body, /value="recover"/)
    setAlice({ up: true, token: 'tok123', error: null })
  })

  it('relays with the real key and rejects unknown or disabled keys', async () => {
    const ok = await call(relayPort, 'POST', '/v1/chat/completions', { authorization: 'Bearer key-alice' }, '{}')
    assert.equal(ok.status, 200)
    assert.deepEqual(seen.at(-1), { auth: 'Bearer REAL', path: '/v1/chat/completions' })
    assert.match(log.lines.at(-1) ?? '', /^relay: user=alice POST \/v1\/chat\/completions -> 200/)

    assert.equal((await call(relayPort, 'GET', '/v1/models', { authorization: 'Bearer nope' })).status, 401)
    assert.equal((await call(relayPort, 'GET', '/v1/models', { authorization: 'Bearer key-bob' })).status, 401)
    assert.equal((await call(relayPort, 'GET', '/v1/models')).status, 401)
    assert.equal((await call(relayPort, 'GET', '/other', { 'x-api-key': 'key-alice' })).status, 404)
  })
})
