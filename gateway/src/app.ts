// Composition root: the one place that constructs the gateway's objects.
// Everything else receives its collaborators through its constructor.

import { createServer, type Server } from 'node:http'
import { Sessions, SocketPasswords, type Passwords } from './auth.ts'
import { consoleLogger, type Logger } from './log.ts'
import { messagePage } from './pages.ts'
import { DshProxy } from './proxy.ts'
import { Relay } from './relay.ts'
import { Gateway } from './server.ts'
import type { StateSource } from './state.ts'

export interface AppOptions {
  state: StateSource
  log?: Logger
  passwords?: Passwords
  /** Where users' dsh instances listen. */
  dshHost?: string
}

export interface App {
  gateway: Server
  relay: Server
}

export function createApp(options: AppOptions): App {
  const log = options.log ?? consoleLogger
  const gateway = new Gateway({
    state: options.state,
    sessions: new Sessions(options.state),
    passwords: options.passwords ?? new SocketPasswords(options.state, log),
    proxy: new DshProxy(options.dshHost),
    log,
  })
  const relay = new Relay(options.state, log)
  return { gateway: gatewayServer(gateway, log), relay: createServer((req, res) => relay.handle(req, res)) }
}

function gatewayServer(gateway: Gateway, log: Logger): Server {
  const server = createServer((req, res) => {
    gateway.handle(req, res).catch((error: unknown) => {
      log.error(`gateway: ${req.method} ${req.url}: ${String(error)}`)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' })
        res.end(messagePage('Error', 'Something went wrong.'))
      } else {
        res.destroy()
      }
    })
  })
  server.on('upgrade', (req, socket, head) => gateway.upgrade(req, socket, head))
  return server
}
