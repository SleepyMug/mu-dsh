// Reverse proxy from /u/<user>/* to that user's dsh on 127.0.0.1:<port>.
//
// The incoming Host header is preserved: dsh checks Host/Origin against its
// --trusted-host list and binds its session cookie to that authority. dsh
// sets its cookie with Path=/ under a name derived only from the authority,
// so every user's cookie would collide; responses rewrite the path to the
// user's own prefix.

import { request, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export function forwardHeaders(headers: IncomingHttpHeaders, keepUpgrade = false): OutgoingHttpHeaders {
  const out: Record<string, string | string[]> = {}
  const connectionTokens = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  )
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    if (keepUpgrade && (name === 'connection' || name === 'upgrade')) {
      out[name] = value
      continue
    }
    if (HOP_BY_HOP.has(name) || connectionTokens.has(name)) continue
    out[name] = value
  }
  return out
}

/** Prefix a cookie's Path attribute: `Path=/` becomes `Path=/u/alice/`. */
export function rewriteSetCookie(cookie: string, prefix: string): string {
  let sawPath = false
  const parts = cookie.split(';').map((part, index) => {
    if (index === 0) return part
    const m = /^\s*path\s*=\s*(.*)$/i.exec(part)
    if (!m) return part
    sawPath = true
    const path = m[1].trim() || '/'
    return ` Path=${prefix}${path.startsWith('/') ? path : `/${path}`}`
  })
  if (!sawPath) parts.push(` Path=${prefix}/`)
  return parts.join(';')
}

/** Keep redirects inside the user's prefix. Relative and absolute-URL locations pass unchanged. */
export function rewriteLocation(location: string, prefix: string): string {
  return location.startsWith('/') && !location.startsWith('//') ? prefix + location : location
}

export function responseHeaders(headers: IncomingHttpHeaders, prefix: string): OutgoingHttpHeaders {
  const out = forwardHeaders(headers)
  const cookies = headers['set-cookie']
  if (cookies !== undefined) out['set-cookie'] = cookies.map((c) => rewriteSetCookie(c, prefix))
  if (typeof headers.location === 'string') out.location = rewriteLocation(headers.location, prefix)
  return out
}

export interface ProxyTarget {
  port: number
  /** Path and query on the dsh side, e.g. `/api/x?y`. */
  path: string
  /** URL prefix of this user on the gateway, e.g. `/u/alice`. */
  prefix: string
  headers: OutgoingHttpHeaders
}

/** Forwards requests to a user's dsh listening on `host`. */
export class DshProxy {
  readonly host: string

  constructor(host = '127.0.0.1') {
    this.host = host
  }

  /**
   * Forward one HTTP request. `intercept` sees the upstream response first and
   * may take it over (returning true), e.g. to turn dsh's 401 into a sign-in redirect.
   */
  http(req: IncomingMessage, res: ServerResponse, target: ProxyTarget, intercept?: (upstream: IncomingMessage) => boolean): void {
    const upstreamReq = request(
      { host: this.host, port: target.port, method: req.method, path: target.path, headers: target.headers },
      (upstream) => {
        if (intercept?.(upstream)) {
          upstream.resume()
          return
        }
        res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, responseHeaders(upstream.headers, target.prefix))
        upstream.pipe(res)
        upstream.on('error', () => res.destroy())
      },
    )
    upstreamReq.on('error', (error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`dsh is not reachable: ${error.message}\n`)
    })
    res.on('close', () => {
      if (!res.writableFinished) upstreamReq.destroy()
    })
    req.pipe(upstreamReq)
  }

  /** Forward a WebSocket (or any HTTP/1.1 upgrade) handshake and then splice the sockets. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer, target: ProxyTarget): void {
    const upstreamReq = request({ host: this.host, port: target.port, method: req.method, path: target.path, headers: target.headers })
    upstreamReq.on('upgrade', (upstream, upstreamSocket, upstreamHead) => {
      writeRawResponse(socket, upstream, target.prefix)
      if (upstreamHead.length > 0) socket.write(upstreamHead)
      if (head.length > 0) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
      const close = () => {
        upstreamSocket.destroy()
        socket.destroy()
      }
      upstreamSocket.on('error', close)
      socket.on('error', close)
      upstreamSocket.on('close', close)
      socket.on('close', close)
    })
    upstreamReq.on('response', (upstream) => {
      // The upstream refused to upgrade (e.g. 401); relay its answer and close.
      writeRawResponse(socket, upstream, target.prefix)
      upstream.pipe(socket)
    })
    upstreamReq.on('error', () => {
      socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\ncontent-length: 0\r\n\r\n')
    })
    socket.on('error', () => upstreamReq.destroy())
    upstreamReq.end()
  }
}

function writeRawResponse(socket: Duplex, upstream: IncomingMessage, prefix: string): void {
  const lines = [`HTTP/1.1 ${upstream.statusCode ?? 502} ${upstream.statusMessage ?? ''}`]
  const headers = upstream.statusCode === 101 ? upstream.headers : responseHeaders(upstream.headers, prefix)
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`)
  }
  // A refused upgrade's body is relayed decoded and delimited by closing the socket.
  if (upstream.statusCode !== 101) lines.push('connection: close')
  socket.write(lines.join('\r\n') + '\r\n\r\n')
}
