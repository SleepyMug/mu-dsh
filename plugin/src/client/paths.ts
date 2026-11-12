/** Addresses and paths, without a browser or a host. */

import { isAbsoluteWorkspacePath, parseFileAddress, resolveWorkspacePath, workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { Origin } from './tree.ts'

/**
 * Every file address, as the sidebar's glob matcher reads it. dsh's file
 * preview claims file addresses with the same pattern; `dsh-resource://file/**`
 * would not do, because a globstar matches no `.` or `..` segment, so a link
 * to `.` or `../out` would pass this type by.
 */
export const FILE_ADDRESS_PATTERN = 'dsh-resource://file/[\\s\\S]+'

/** `/a/b/` → `/a/b`; `/` stays itself. */
export function trimSlashes(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  return trimmed === '' ? '/' : trimmed
}

export function parentOf(path: string): string | undefined {
  const trimmed = trimSlashes(path)
  if (trimmed === '/') return undefined
  const cut = trimmed.lastIndexOf('/')
  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}

export function childOf(parent: string, name: string): string {
  return parent === '/' ? `/${name}` : `${parent}/${name}`
}

export function nameOf(path: string): string {
  const trimmed = trimSlashes(path)
  return trimmed === '/' ? '/' : trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

export interface SessionPath {
  readonly sessionId: string
  /** The address's path made absolute; `undefined` when it is relative and the workspace is unknown. */
  readonly absolute: string | undefined
  /** The path as the address spells it: relative to the workspace, or absolute. */
  readonly path: string
}

/** A session file address's Session and path; `undefined` for any other address. */
export function sessionPathOf(address: string, cwdOf: (sessionId: string) => string | undefined): SessionPath | undefined {
  const parsed = parseFileAddress(address)
  if (parsed === undefined || parsed.scope !== 'session') return undefined
  if (isAbsoluteWorkspacePath(parsed.path)) return { sessionId: parsed.sessionId, path: parsed.path, absolute: trimSlashes(parsed.path) }
  const cwd = cwdOf(parsed.sessionId)
  const absolute = cwd === undefined || cwd === '' ? undefined : trimSlashes(resolveWorkspacePath(cwd, parsed.path))
  return { sessionId: parsed.sessionId, path: parsed.path, absolute }
}

/** The tab chip's text for an address: its last segment, or the workspace's name for the workspace itself. */
export function titleOf(address: string, cwdOf: (sessionId: string) => string | undefined): string {
  const where = sessionPathOf(address, cwdOf)
  if (where === undefined) return address
  const workspaceItself = where.path.replace(/\/+$/, '') === '' && !isAbsoluteWorkspacePath(where.path)
  if (!workspaceItself) return nameOf(where.path)
  const cwd = cwdOf(where.sessionId)
  return cwd === undefined ? '/' : workspaceTitleOf(cwd) || cwd
}

/** The session an address belongs to: its own for a session file address, the tab's for the Files page. */
export function sessionOf<S extends string>(contentId: string, tabSession: S): S {
  const address = parseFileAddress(contentId)
  return address?.scope === 'session' ? address.sessionId as S : tabSession
}

/** What a tab shows, from its content id: the Files page has a page address, a folder tab a file address. */
export function originOf(contentId: string, cwd: string | undefined): Origin {
  const workspace = cwd === undefined || cwd === '' ? undefined : trimSlashes(cwd)
  if (parseFileAddress(contentId) === undefined) return { kind: 'workspace', root: workspace }
  return { kind: 'address', path: sessionPathOf(contentId, () => workspace)?.absolute, workspace }
}
