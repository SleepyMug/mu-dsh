/**
 * The routes the host half serves and the browser half calls, and what they
 * carry. Both halves import this module; it holds no runtime code beyond the
 * route paths.
 */

/** `GET ?path=<absolute path>`: what the path is, and a directory's entries. */
export const ENTRY_PATH = '/api/mu-dsh-files.entry'

/**
 * `GET`/`HEAD ?path=<absolute path>`: a regular file as itself, a directory as
 * a ZIP archive, both as attachments. `HEAD` runs every check `GET` does
 * (for a directory, the walk against the archive limits) without sending a
 * body, so the browser can report a refusal before it starts a download.
 */
export const DOWNLOAD_PATH = '/api/mu-dsh-files.download'

/**
 * `GET`: one stream of watch events, newline-delimited JSON, for as long as
 * the request stays open; the first event names the stream. `POST` a
 * {@link WatchControl}: change what that stream watches.
 *
 * A page holds one stream for all its trees, so watching many directories
 * costs one connection; what to watch travels separately, so each directory's
 * watch starts and ends on its own.
 */
export const WATCH_PATH = '/api/mu-dsh-files.watch'

export type EntryType = 'file' | 'directory' | 'other'

export interface DirectoryEntry {
  readonly name: string
  readonly type: EntryType
  /** Bytes, for a regular file whose backend reports it. */
  readonly size?: number
}

export type Entry =
  | { readonly type: 'file'; readonly path: string; readonly size?: number }
  | { readonly type: 'other'; readonly path: string }
  | {
    readonly type: 'directory'
    readonly path: string
    /** In the backend's order, cut at the listing cap. */
    readonly entries: readonly DirectoryEntry[]
    readonly truncated: boolean
  }

/** A refusal's message, URI-encoded, for responses without a body. */
export const REFUSAL_HEADER = 'X-Mu-Dsh-Refusal'

/** The JSON body of every refusal; `error` names the reason. */
export interface Refusal {
  readonly error: RefusalCode
  readonly message: string
}

export type RefusalCode =
  | 'bad-request'
  | 'not-found'
  | 'not-permitted'
  | 'not-regular'
  | 'too-large'
  | 'unavailable'

/**
 * What a watch stream reports, each event about one path exactly as the
 * browser asked to watch it.
 *
 * - `open`: the stream's first event, naming it for {@link WatchControl}.
 *   Some event (at least a `ping`) follows every `heartbeatMs`, so a reader
 *   that hears nothing for longer knows the stream is dead.
 * - `ready`: the path is watched. A listing read after this event stays
 *   current until a `change`; one read before it may already be stale.
 *   Asking to watch a path that is already watched answers `ready` again.
 * - `change`: what the path holds may have changed (for a directory, its
 *   direct entries). Changes are gathered, so one event may stand for many.
 * - `lost`: the path is not watched for now, so changes go unreported. With
 *   `retrying` the host keeps trying and says `ready` once it succeeds.
 */
export type WatchEvent =
  | { readonly type: 'open'; readonly stream: string; readonly heartbeatMs: number }
  | { readonly type: 'ready'; readonly path: string }
  | { readonly type: 'change'; readonly path: string }
  | { readonly type: 'lost'; readonly path: string; readonly refusal: Refusal; readonly retrying: boolean }
  | { readonly type: 'ping' }

/** The body of a `POST` to {@link WATCH_PATH}: absolute paths to start and stop watching on one stream. */
export interface WatchControl {
  readonly stream: string
  readonly add?: readonly string[]
  readonly remove?: readonly string[]
}
