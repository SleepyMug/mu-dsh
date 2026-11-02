// mu-dsh gateway entry point: waits for the control plane's state file,
// then serves the public gateway and the loopback LLM relay.

import type { Server } from 'node:http'
import { createApp } from './app.ts'
import { consoleLogger, type Logger } from './log.ts'
import { StateFile, type GatewayState } from './state.ts'

function listenKey(state: GatewayState): string {
  return JSON.stringify([state.gateway.listen_host, state.gateway.listen_port, state.relay.listen_host, state.relay.listen_port])
}

function listen(server: Server, host: string, port: number, what: string, log: Logger): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      log.info(`gateway: ${what} listening on ${host}:${port}`)
      resolve()
    })
  })
}

async function main(): Promise<void> {
  const log = consoleLogger
  const state = new StateFile(process.env.MU_DSH_GATEWAY_STATE ?? '/run/mu-dsh/gateway.json', log)
  await state.waitUntilLoaded()
  const initial = state.current
  const app = createApp({ state, log })
  await listen(app.relay, initial.relay.listen_host, initial.relay.listen_port, 'LLM relay', log)
  await listen(app.gateway, initial.gateway.listen_host, initial.gateway.listen_port, 'gateway', log)

  const key = listenKey(initial)
  state.watch((next) => {
    if (listenKey(next) !== key) {
      // Listen addresses only apply at startup; systemd (Restart=always) brings us back.
      log.info('gateway: listen address changed; restarting')
      process.exit(0)
    }
  })

  const shutdown = () => {
    for (const server of [app.gateway, app.relay]) {
      server.close()
      server.closeAllConnections()
    }
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

main().catch((error: unknown) => {
  consoleLogger.error(`gateway: ${String(error)}`)
  process.exit(1)
})
