/**
 * The host half's routes as the browser calls them. URLs are relative to the
 * document, as dsh's own downloads are, so they work under any mount
 * (mu-dsh serves each user's dsh at /u/<user>/).
 */

import {
  DOWNLOAD_PATH,
  ENTRY_PATH,
  REFUSAL_HEADER,
  WATCH_PATH,
  type Entry,
  type Refusal,
  type RefusalCode,
  type WatchControl,
  type WatchEvent,
} from '../wire.ts'

export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: Refusal }

export function routeUrl(base: string, route: string, path?: string): string {
  const url = new URL(route.slice(1), base)
  if (path !== undefined) url.searchParams.set('path', path)
  return url.href
}

const CODES: ReadonlySet<string> = new Set<RefusalCode>(['bad-request', 'not-found', 'not-permitted', 'not-regular', 'too-large', 'unavailable'])

/**
 * A refusal from a response that is not OK: by its JSON body when it has one,
 * else by its status, with the host's message from the refusal header (HEAD).
 */
async function refusalOf(response: Response): Promise<Refusal> {
  try {
    const body = await response.json() as Partial<Refusal>
    if (typeof body.error === 'string' && CODES.has(body.error) && typeof body.message === 'string') return body as Refusal
  } catch {
    // No JSON body: a HEAD response, or a proxy's error page.
  }
  let message = `HTTP ${response.status}`
  const header = response.headers.get(REFUSAL_HEADER)
  if (header !== null) {
    try {
      message = decodeURIComponent(header)
    } catch {
      // A malformed header leaves the status to speak.
    }
  }
  return { error: refusalForStatus(response.status), message }
}

export function refusalForStatus(status: number): RefusalCode {
  switch (status) {
    case 400: return 'bad-request'
    case 403: return 'not-permitted'
    case 404: return 'not-found'
    case 409: return 'not-regular'
    case 413: return 'too-large'
    default: return 'unavailable'
  }
}

function failed(error: unknown): Result<never> {
  return { ok: false, refusal: { error: 'unavailable', message: error instanceof Error ? error.message : String(error) } }
}

export class FilesApi {
  readonly base: () => string
  readonly fetch: typeof globalThis.fetch

  constructor(base: () => string, fetcher: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init)) {
    this.base = base
    this.fetch = fetcher
  }

  async entry(path: string, signal: AbortSignal): Promise<Result<Entry>> {
    try {
      const response = await this.fetch(routeUrl(this.base(), ENTRY_PATH, path), { signal })
      if (!response.ok) return { ok: false, refusal: await refusalOf(response) }
      return { ok: true, value: await response.json() as Entry }
    } catch (error) {
      if (signal.aborted) throw error
      return failed(error)
    }
  }

  downloadUrl(path: string): string {
    return routeUrl(this.base(), DOWNLOAD_PATH, path)
  }

  /** Ask whether a download would be refused, without starting it. */
  async check(path: string, signal: AbortSignal): Promise<Result<string>> {
    const url = this.downloadUrl(path)
    try {
      const response = await this.fetch(url, { method: 'HEAD', signal })
      if (!response.ok) return { ok: false, refusal: await refusalOf(response) }
      return { ok: true, value: url }
    } catch (error) {
      if (signal.aborted) throw error
      return failed(error)
    }
  }

  /**
   * Open a watch stream and read its events until it ends or `signal` aborts.
   * Rejects when the stream cannot be opened or breaks.
   */
  async *watchEvents(signal: AbortSignal): AsyncGenerator<WatchEvent> {
    const response = await this.fetch(routeUrl(this.base(), WATCH_PATH), { signal, cache: 'no-store' })
    if (!response.ok || response.body === null) {
      await response.body?.cancel()
      throw new Error(`the host refused a watch stream: HTTP ${response.status}`)
    }
    for await (const line of linesOf(chunksOf(response.body.pipeThrough(new TextDecoderStream())))) {
      if (line !== '') yield JSON.parse(line) as WatchEvent
    }
  }

  /**
   * Change what a watch stream watches. `false` when the host no longer has
   * the stream; rejects when the host cannot be reached or refuses.
   */
  async watchControl(control: WatchControl): Promise<boolean> {
    const response = await this.fetch(routeUrl(this.base(), WATCH_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(control),
    })
    await response.body?.cancel()
    if (response.ok) return true
    if (response.status === 404) return false
    throw new Error(`the host refused to change a watch stream: HTTP ${response.status}`)
  }
}

/** A stream's chunks, read without relying on streams being async iterable, which not every browser supports. */
export async function* chunksOf<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
  const reader = stream.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      yield value
    }
  } finally {
    // Ends the stream when its reader stops early; one already ended or broken has nothing to cancel.
    reader.cancel().catch(() => {})
  }
}

/** Split a stream of text into lines, holding back an unfinished last line until it ends. */
export async function* linesOf(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let buffer = ''
  for await (const chunk of chunks) {
    buffer += chunk
    let cut: number
    while ((cut = buffer.indexOf('\n')) >= 0) {
      yield buffer.slice(0, cut)
      buffer = buffer.slice(cut + 1)
    }
  }
}

/** Hand a download URL to the browser's download manager; the server names the file. */
export function saveUrl(url: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = ''
  anchor.rel = 'noopener'
  anchor.style.display = 'none'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}
