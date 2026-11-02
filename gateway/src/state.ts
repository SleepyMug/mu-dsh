// The control plane's view of users and processes, read from
// /run/mu-dsh/gateway.json (see control/state.py for the format). The file is
// replaced atomically, so a poll on its stat picks up every new version.

import { readFileSync, unwatchFile, watchFile } from 'node:fs'
import { consoleLogger, type Logger } from './log.ts'

export interface UserState {
  port: number
  llm_key: string
  enabled: boolean
  up: boolean
  token: string | null
  error: string | null
}

export interface GatewayState {
  version: 1
  gateway: {
    listen_host: string
    listen_port: number
    public_url: string
    session_max_age_days: number
  }
  session_secret: string
  /** The control plane's password-check socket (see control/authserver.py). */
  auth_socket: string
  relay: {
    listen_host: string
    listen_port: number
    upstream: string
    api_key: string
  }
  users: Record<string, UserState>
}

/** What the gateway and relay need from the state, however it is stored. */
export interface StateSource {
  readonly current: GatewayState
  /** The enabled user owning a relay key, if any. */
  userForKey(key: string): string | undefined
}

export function parseState(text: string): GatewayState {
  const state = JSON.parse(text) as GatewayState
  if (state.version !== 1) throw new Error(`unsupported gateway state version ${String(state.version)}`)
  if (!state.session_secret) throw new Error('gateway state has no session_secret')
  if (typeof state.users !== 'object' || state.users === null) throw new Error('gateway state has no users')
  return state
}

/** A StateSource held in memory; also the base of the file-backed store. */
export class MemoryState implements StateSource {
  #state: GatewayState | undefined
  #byKey = new Map<string, string>()

  constructor(state?: GatewayState) {
    if (state !== undefined) this.set(state)
  }

  get current(): GatewayState {
    if (this.#state === undefined) throw new Error('gateway state not loaded')
    return this.#state
  }

  get loaded(): boolean {
    return this.#state !== undefined
  }

  set(state: GatewayState): void {
    this.#state = state
    this.#byKey = new Map(Object.entries(state.users).map(([name, user]) => [user.llm_key, name]))
  }

  userForKey(key: string): string | undefined {
    const name = this.#byKey.get(key)
    return name !== undefined && this.#state?.users[name]?.enabled ? name : undefined
  }
}

/** gateway.json on disk, re-read whenever the control plane replaces it. */
export class StateFile extends MemoryState {
  readonly path: string
  readonly log: Logger

  constructor(path: string, log: Logger = consoleLogger) {
    super()
    this.path = path
    this.log = log
  }

  /** Re-read the file. Returns false and keeps the old state on a bad file. */
  reload(): boolean {
    let next: GatewayState
    try {
      next = parseState(readFileSync(this.path, 'utf8'))
    } catch (error) {
      if (this.loaded) this.log.error(`gateway: ignoring unreadable ${this.path}: ${String(error)}`)
      return false
    }
    this.set(next)
    return true
  }

  watch(onChange: (state: GatewayState) => void, intervalMs = 500): () => void {
    const listener = () => {
      if (this.reload()) onChange(this.current)
    }
    watchFile(this.path, { interval: intervalMs }, listener)
    return () => unwatchFile(this.path, listener)
  }

  async waitUntilLoaded(intervalMs = 500): Promise<void> {
    let warned = false
    while (!this.reload()) {
      if (!warned) {
        this.log.error(`gateway: waiting for ${this.path}`)
        warned = true
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
  }
}
