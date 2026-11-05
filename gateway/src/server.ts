// The public gateway: login, logout, account and workspace actions, and
// per-user proxying under /u/<user>/.

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { SESSION_COOKIE, stripCookie, type Sessions } from './auth.ts'
import type { Control, WorkspaceAction } from './control.ts'
import type { Logger } from './log.ts'
import { loginPage, messagePage, passwordPage, portalPage, resetPage, startingPage } from './pages.ts'
import { forwardHeaders, type DshProxy, type ProxyTarget } from './proxy.ts'
import type { StateSource } from './state.ts'

const USER_PATH = /^\/u\/([a-z_][a-z0-9_.-]{0,31})(\/.*)?$/
const MAX_FORM_BYTES = 16 * 1024

export interface GatewayDeps {
  state: StateSource
  sessions: Sessions
  control: Control
  proxy: DshProxy
  log: Logger
}

const WORKSPACE_ACTIONS: readonly WorkspaceAction[] = ['restart', 'recover', 'reset']

type Headers = Record<string, string | string[]>

function send(res: ServerResponse, status: number, body: string, headers: Headers = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

function redirect(res: ServerResponse, status: number, location: string, headers: Headers = {}): void {
  res.writeHead(status, { location, 'cache-control': 'no-store', ...headers })
  res.end()
}

function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_FORM_BYTES) {
        reject(new Error('form too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(new URLSearchParams(Buffer.concat(chunks).toString('utf8'))))
    req.on('error', reject)
  })
}

/** Only follow `next` back into the signed-in user's own area or account pages. */
function safeNext(next: string | null, user: string): string {
  const home = `/u/${user}/`
  if (next === '/account/password' || next === '/account/reset') return next
  return next !== null && next.startsWith(home) && !next.includes('\\') ? next : home
}

/** Navigations get HTML pages; fetch/XHR/WebSocket get bare status codes. */
function isNavigation(req: IncomingMessage): boolean {
  return req.method === 'GET' && (req.headers['sec-fetch-mode'] === 'navigate' || /text\/html/.test(req.headers.accept ?? ''))
}

type Deny = (status: number, title: string, message: string, location?: string) => void

export class Gateway {
  readonly state: StateSource
  readonly sessions: Sessions
  readonly control: Control
  readonly proxy: DshProxy
  readonly log: Logger

  constructor(deps: GatewayDeps) {
    this.state = deps.state
    this.sessions = deps.sessions
    this.control = deps.control
    this.proxy = deps.proxy
    this.log = deps.log
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://gateway.invalid')
    const path = url.pathname

    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok\n')
      return
    }
    if (path === '/') {
      const user = this.sessions.userFor(req)
      if (!user) return redirect(res, 302, '/login')
      const notice = url.searchParams.get('changed') === 'password' ? 'Your password was changed.' : undefined
      return send(res, 200, portalPage(user, { notice, mode: this.state.current.users[user]?.mode }))
    }
    if (path === '/account/password') return this.changePassword(req, res)
    if (path === '/account/workspace') return this.workspace(req, res)
    if (path === '/account/reset') {
      const user = this.sessions.userFor(req)
      if (!user) return redirect(res, 303, `/login?next=${encodeURIComponent('/account/reset')}`)
      return send(res, 200, resetPage(user))
    }
    if (path === '/login') {
      if (req.method === 'POST') return this.login(req, res)
      const user = this.sessions.userFor(req)
      if (user) return redirect(res, 302, safeNext(url.searchParams.get('next'), user))
      return send(res, 200, loginPage({ next: url.searchParams.get('next') ?? undefined }))
    }
    if (path === '/logout') {
      req.resume()
      return redirect(res, 303, '/login', { 'set-cookie': this.sessions.clear() })
    }
    const m = USER_PATH.exec(path)
    if (m) return this.proxyUser(req, res, m[1], m[2], url)
    send(res, 404, messagePage('Not found', 'There is nothing here.'))
  }

  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://gateway.invalid')
    const m = USER_PATH.exec(url.pathname)
    const reject = (status: number, title: string) => {
      socket.end(`HTTP/1.1 ${status} ${title}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
    }
    if (!m) return reject(404, 'Not Found')
    const target = this.authorize(req, m[1], m[2], url, (status, title) => reject(status === 303 ? 401 : status, title))
    if (target !== undefined) this.proxy.upgrade(req, socket, head, target)
  }

  private async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let form: URLSearchParams
    try {
      form = await readForm(req)
    } catch {
      return send(res, 413, messagePage('Request too large', 'The login form was too large.'))
    }
    const username = (form.get('username') ?? '').trim()
    const password = form.get('password') ?? ''
    const next = form.get('next')
    const ok = await this.control.verify(username, password)
    if (!ok || !this.state.current.users[username]?.enabled) {
      this.log.info(`gateway: failed login for ${JSON.stringify(username)}`)
      return send(res, 401, loginPage({ error: 'Wrong user name or password.', username, next: next ?? undefined }))
    }
    this.log.info(`gateway: ${username} signed in`)
    redirect(res, 303, safeNext(next, username), { 'set-cookie': this.sessions.issue(username) })
  }

  private async changePassword(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = this.sessions.userFor(req)
    if (!user) {
      req.resume()
      return redirect(res, 303, `/login?next=${encodeURIComponent('/account/password')}`)
    }
    if (req.method !== 'POST') return send(res, 200, passwordPage(user))
    let form: URLSearchParams
    try {
      form = await readForm(req)
    } catch {
      return send(res, 413, messagePage('Request too large', 'The form was too large.'))
    }
    const next = form.get('new') ?? ''
    if (next !== (form.get('repeat') ?? '')) return send(res, 400, passwordPage(user, 'The new passwords do not match.'))
    const error = await this.control.change(user, form.get('current') ?? '', next)
    if (error !== undefined) return send(res, 400, passwordPage(user, error))
    this.log.info(`gateway: ${user} changed their password`)
    redirect(res, 303, '/?changed=password')
  }

  /** Restart the signed-in user's dsh (normally, in recovery mode, or after a settings reset). */
  private async workspace(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const user = this.sessions.userFor(req)
    if (req.method !== 'POST' || !user) {
      req.resume()
      return redirect(res, 303, user ? '/' : '/login')
    }
    let form: URLSearchParams
    try {
      form = await readForm(req)
    } catch {
      return send(res, 413, messagePage('Request too large', 'The form was too large.'))
    }
    const action = form.get('action') as WorkspaceAction
    if (!WORKSPACE_ACTIONS.includes(action)) return send(res, 400, messagePage('Unknown action', 'Nothing was changed.'))
    const error = await this.control.workspace(user, action)
    if (error !== undefined) return send(res, 503, messagePage('Not restarted', error))
    this.log.info(`gateway: ${user} asked for ${action}`)
    // The old dsh is stopped and gateway.json says so; read it now, not at the next poll.
    this.state.refresh()
    redirect(res, 303, `/u/${user}/`)
  }

  private proxyUser(req: IncomingMessage, res: ServerResponse, name: string, rest: string | undefined, url: URL): void {
    const target = this.authorize(req, name, rest, url, (status, title, message, location) => {
      req.resume()
      if (location !== undefined) return redirect(res, status, location)
      if (status === 503 && isNavigation(req)) {
        return send(res, 503, startingPage(name, message || null, this.state.current.users[name]?.mode))
      }
      if (!isNavigation(req)) {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        res.end(`${title}\n`)
        return
      }
      send(res, status, messagePage(title, message))
    })
    if (target === undefined) return

    // dsh answers its index with 401 until the browser holds dsh's own cookie.
    // The gateway already knows who this is, so it signs the browser into dsh
    // by redirecting through dsh's one-time launch-token exchange.
    const isIndex = req.method === 'GET' && rest === '/' && !url.searchParams.has('token')
    const token = this.state.current.users[name]?.token
    this.proxy.http(req, res, target, (upstream) => {
      if (!(isIndex && upstream.statusCode === 401 && token)) return false
      redirect(res, 302, `/u/${name}/?token=${encodeURIComponent(token)}`, { 'referrer-policy': 'no-referrer' })
      return true
    })
  }

  /** Common checks for /u/<name>/...; returns the proxy target, or calls `deny` and returns undefined. */
  private authorize(req: IncomingMessage, name: string, rest: string | undefined, url: URL, deny: Deny): ProxyTarget | undefined {
    const prefix = `/u/${name}`
    if (rest === undefined) {
      deny(301, 'Moved', '', `${prefix}/${url.search}`)
      return undefined
    }
    const user = this.sessions.userFor(req)
    if (user === undefined) {
      deny(303, 'Sign in required', '', `/login?next=${encodeURIComponent(url.pathname + url.search)}`)
      return undefined
    }
    if (user !== name) {
      deny(403, 'Forbidden', `You are signed in as ${user}, not ${name}.`)
      return undefined
    }
    const record = this.state.current.users[name]
    if (!record?.up) {
      deny(503, 'Starting', record?.error ?? '')
      return undefined
    }
    const headers = forwardHeaders(req.headers, req.headers.upgrade !== undefined)
    const cookie = stripCookie(req.headers.cookie, SESSION_COOKIE)
    if (cookie === undefined) delete headers.cookie
    else headers.cookie = cookie
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? ''
    headers['x-forwarded-proto'] = this.sessions.secure ? 'https' : 'http'
    return { port: record.port, path: rest + url.search, prefix, headers }
  }
}
