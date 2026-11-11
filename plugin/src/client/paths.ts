/** Addresses and paths, without a browser or a host. */

import { isAbsoluteWorkspacePath, parseFileAddress, resolveWorkspacePath, workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'

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
