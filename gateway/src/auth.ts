// The gateway's own signed session cookie.

import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { StateSource } from './state.ts'

export const SESSION_COOKIE = 'mu_dsh_session'

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

export function createSession(user: string, secret: string, maxAgeSeconds: number, now = Date.now()): string {
  const body = `${Buffer.from(user).toString('base64url')}.${Math.floor(now / 1000) + maxAgeSeconds}`
  return `${body}.${sign(secret, body)}`
}

/** The user a session cookie names, or undefined when it is forged, malformed, or expired. */
export function readSession(value: string | undefined, secret: string, now = Date.now()): string | undefined {
  if (!value) return undefined
  const parts = value.split('.')
  if (parts.length !== 3) return undefined
  const [user, expires, mac] = parts
  const body = `${user}.${expires}`
  const expected = Buffer.from(sign(secret, body))
  const actual = Buffer.from(mac)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
  if (!(Number(expires) * 1000 > now)) return undefined
  return Buffer.from(user, 'base64url').toString()
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const segment of (header ?? '').split(';')) {
    const at = segment.indexOf('=')
    if (at === -1) continue
    const name = segment.slice(0, at).trim()
    if (name && !cookies.has(name)) cookies.set(name, segment.slice(at + 1).trim())
  }
  return cookies
}

/** The Cookie header without one cookie, or undefined when nothing is left. */
export function stripCookie(header: string | undefined, name: string): string | undefined {
  if (header === undefined) return undefined
  const kept = header
    .split(';')
    .map((s) => s.trim())
    .filter((s) => {
      const at = s.indexOf('=')
      return s !== '' && (at === -1 ? s : s.slice(0, at)).trim() !== name
    })
  return kept.length > 0 ? kept.join('; ') : undefined
}

/** Gateway sign-ins, signed with the session secret the control plane publishes. */
export class Sessions {
  readonly state: StateSource

  constructor(state: StateSource) {
    this.state = state
  }

  get maxAgeSeconds(): number {
    return this.state.current.gateway.session_max_age_days * 86400
  }

  get secure(): boolean {
    return this.state.current.gateway.public_url.startsWith('https:')
  }

  /** The signed-in user, if their session is valid and they are still enabled. */
  userFor(req: IncomingMessage): string | undefined {
    const state = this.state.current
    const user = readSession(parseCookies(req.headers.cookie).get(SESSION_COOKIE), state.session_secret)
    return user !== undefined && state.users[user]?.enabled ? user : undefined
  }

  /** A Set-Cookie header signing `user` in. */
  issue(user: string): string {
    const value = createSession(user, this.state.current.session_secret, this.maxAgeSeconds)
    return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${this.maxAgeSeconds}; HttpOnly; SameSite=Lax${this.secure ? '; Secure' : ''}`
  }

  /** A Set-Cookie header signing the browser out. */
  clear(): string {
    return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${this.secure ? '; Secure' : ''}`
  }
}
