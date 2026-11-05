// The gateway's line to the root control plane: password checks and changes
// (PAM needs root) and workspace actions for the signed-in user.

import { createConnection } from 'node:net'
import type { Logger } from './log.ts'
import type { StateSource } from './state.ts'

export type WorkspaceAction = 'restart' | 'recover' | 'reset'

/** What the gateway asks of the root control plane. */
export interface Control {
  /** Check a user's Unix password. */
  verify(user: string, password: string): Promise<boolean>
  /** Resolves to undefined on success, or a message to show the user. */
  change(user: string, current: string, next: string): Promise<string | undefined>
  /** Restart the user's dsh (normally, in recovery mode, or after a settings reset);
   * resolves once the old dsh is stopped, to undefined or a message to show. */
  workspace(user: string, action: WorkspaceAction): Promise<string | undefined>
}

interface Reply {
  ok?: unknown
  error?: unknown
}

/**
 * Asks the control plane over its Unix socket (see control/controlserver.py).
 * One JSON line each way; any failure counts as a refusal.
 */
export class SocketControl implements Control {
  readonly state: StateSource
  readonly log: Logger
  readonly timeoutMs: number

  constructor(state: StateSource, log: Logger, timeoutMs = 75_000) {
    this.state = state
    this.log = log
    this.timeoutMs = timeoutMs
  }

  async verify(user: string, password: string): Promise<boolean> {
    return (await this.ask({ op: 'check', user, password }))?.ok === true
  }

  async change(user: string, current: string, next: string): Promise<string | undefined> {
    const reply = await this.ask({ op: 'change_password', user, password: current, new_password: next })
    if (reply?.ok === true) return undefined
    return typeof reply?.error === 'string' ? reply.error : 'The password could not be changed.'
  }

  async workspace(user: string, action: WorkspaceAction): Promise<string | undefined> {
    const reply = await this.ask({ op: 'workspace', user, action })
    if (reply?.ok === true) return undefined
    return typeof reply?.error === 'string' ? reply.error : 'The service did not respond.'
  }

  private ask(request: object): Promise<Reply | undefined> {
    return new Promise((resolve) => {
      const socket = createConnection(this.state.current.control_socket)
      let buffer = ''
      const done = (reply: Reply | undefined) => {
        socket.destroy()
        resolve(reply)
      }
      socket.setEncoding('utf8')
      socket.setTimeout(this.timeoutMs, () => {
        this.log.error('gateway: control socket timed out')
        done(undefined)
      })
      socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        try {
          done(JSON.parse(buffer.slice(0, newline)) as Reply)
        } catch {
          done(undefined)
        }
      })
      socket.on('error', (error) => {
        this.log.error(`gateway: control socket failed: ${error.message}`)
        done(undefined)
      })
      socket.on('end', () => done(undefined))
    })
  }
}
