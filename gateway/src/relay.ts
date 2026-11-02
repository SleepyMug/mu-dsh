// LLM relay: an OpenAI-compatible endpoint on loopback that every user's dsh
// talks to. It authenticates the caller by their per-user relay key, swaps in
// the real upstream key, and streams the upstream response back.

import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Logger } from './log.ts'
import { forwardHeaders } from './proxy.ts'
import type { StateSource } from './state.ts'

/** Map `/v1/<rest>` onto the upstream base URL (which itself usually ends in /v1). */
export function upstreamUrl(base: string, incomingPath: string): URL | undefined {
  if (incomingPath !== '/v1' && !incomingPath.startsWith('/v1/') && !incomingPath.startsWith('/v1?')) return undefined
  const upstream = new URL(base)
  const rest = incomingPath.slice(3)
  const queryAt = rest.indexOf('?')
  const restPath = queryAt === -1 ? rest : rest.slice(0, queryAt)
  upstream.pathname = upstream.pathname.replace(/\/+$/, '') + restPath
  upstream.search = queryAt === -1 ? '' : rest.slice(queryAt)
  return upstream
}

function callerKey(req: IncomingMessage): string | undefined {
  const auth = req.headers.authorization
  if (auth !== undefined) {
    const m = /^Bearer\s+(.+)$/i.exec(auth)
    if (m) return m[1].trim()
  }
  const apiKey = req.headers['x-api-key']
  return typeof apiKey === 'string' ? apiKey.trim() : undefined
}

function jsonError(res: ServerResponse, status: number, message: string, type: string): void {
  const body = JSON.stringify({ error: { message, type } })
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export class Relay {
  readonly state: StateSource
  readonly log: Logger

  constructor(state: StateSource, log: Logger) {
    this.state = state
    this.log = log
  }

  handle(req: IncomingMessage, res: ServerResponse): void {
    const started = Date.now()
    const { relay } = this.state.current
    const key = callerKey(req)
    const user = key === undefined ? undefined : this.state.userForKey(key)
    if (user === undefined) {
      req.resume()
      return jsonError(res, 401, 'invalid or missing mu-dsh relay key', 'invalid_request_error')
    }
    const target = upstreamUrl(relay.upstream, req.url ?? '/')
    if (target === undefined) {
      req.resume()
      return jsonError(res, 404, 'the relay only serves /v1/*', 'invalid_request_error')
    }

    const headers = forwardHeaders(req.headers)
    delete headers.authorization
    delete headers['x-api-key']
    delete headers.host
    if (relay.api_key) headers.authorization = `Bearer ${relay.api_key}`

    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const upstreamReq = send(target, { method: req.method, headers }, (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, forwardHeaders(upstream.headers))
      upstream.pipe(res)
      upstream.on('error', () => res.destroy())
      res.on('finish', () => {
        this.log.info(`relay: user=${user} ${req.method} ${req.url} -> ${upstream.statusCode} ${Date.now() - started}ms`)
      })
    })
    upstreamReq.on('error', (error) => {
      this.log.error(`relay: user=${user} ${req.method} ${req.url} -> upstream error: ${error.message}`)
      if (res.headersSent) res.destroy()
      else jsonError(res, 502, `upstream unreachable: ${error.message}`, 'upstream_error')
    })
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy()
    })
    req.pipe(upstreamReq)
  }
}
