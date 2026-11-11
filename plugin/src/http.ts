/** Response helpers shared by the routes. */

import { isAbsolute } from 'node:path'
import { fsErrorCode, refusalFor } from './files.ts'
import { REFUSAL_HEADER, type Refusal, type RefusalCode } from './wire.ts'

const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
}

export function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { ...BASE_HEADERS, ...extra }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: headers({ 'Content-Type': 'application/json' }) })
}

/**
 * A refusal, as a JSON body and, for HEAD (which has no body), the message in
 * a header as well, so the browser can say what was refused before a download.
 */
export function refuse(status: number, error: RefusalCode, message: string): Response {
  const body: Refusal = { error, message }
  const response = json(body, status)
  response.headers.set(REFUSAL_HEADER, encodeURIComponent(message))
  return response
}

/** A HEAD request gets the same status and headers, without the body. */
export function bodyless(response: Response): Response {
  void response.body?.cancel()
  return new Response(null, { status: response.status, headers: response.headers })
}

/** Turn a filesystem refusal into a response; anything else is a bug and propagates. */
export function refuseError(error: unknown): Response {
  const code = fsErrorCode(error)
  if (code === undefined) throw error
  const { status, error: reason } = refusalFor(code)
  return refuse(status, reason, error instanceof Error ? error.message : code)
}

/** The request's `path` parameter, if it is an absolute path. */
export function requestedPath(request: Request): string | Response {
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path === '') return refuse(400, 'bad-request', 'missing path')
  if (path.includes('\0') || !isAbsolute(path)) return refuse(400, 'bad-request', 'path must be absolute')
  return path
}

/**
 * `Content-Disposition` for a download named `name`: an ASCII fallback for
 * old clients, and the exact name in RFC 8187 form.
 */
export function attachment(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%]/g, '_')
  const exact = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${fallback}"; filename*=UTF-8''${exact}`
}
