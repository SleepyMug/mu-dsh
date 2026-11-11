/**
 * The two routes the host half serves and the browser half calls, and what
 * they carry. Both halves import this module; it holds no runtime code beyond
 * the route paths.
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
