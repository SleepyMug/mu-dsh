/**
 * The Files tab's body and chip title. The body draws what the tab's
 * TreeModel says and turns clicks into the face's actions; it decides nothing
 * about routing itself.
 */

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import {
  FileTypeIcon,
  IconChevronUpOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconRefreshOutlineRegular,
  PathLabel,
  Tooltip,
  classifyFileType,
  fileSizeText,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { UseSidebarRightTabInfo, SidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { DirectoryEntry } from '../wire.ts'
import type { FilesApi } from './api.ts'
import { Download, refusalText, type Translate } from './Download.tsx'
import { childOf, originOf, parentOf, sessionOf } from './paths.ts'
import { css } from './styles.ts'
import type { TreeModel, TreeModels, TreeNavigator, TreeSnapshot } from './tree.ts'

export type Tab = SidebarRightTabInfo['tab']

/** What the Files tab needs from the plugin around it (index.ts). */
export interface FilesFace {
  readonly models: TreeModels
  readonly api: FilesApi
  /** What the tab may do in the sidebar; it reads the tab when it acts, so it must see the latest navigation. */
  navigator(sessionId: SessionId, tab: () => Tab): TreeNavigator
  /** Open a file the tree lists, in the tab's pane, with the viewer the sidebar ranks first for it. */
  openFile(sessionId: SessionId, cwd: string | undefined, path: string, paneId: string): void
  /** Show another folder in the tab's place: the Files page for the working directory, a folder tab for anything else. */
  openFolder(tab: Tab, sessionId: SessionId, cwd: string | undefined, path: string): void
}

export interface FilesBodyProps {
  readonly useTabInfo: UseSidebarRightTabInfo
  readonly useSessions: UseSessions
  readonly sessionId: SessionId
  readonly t: Translate
  readonly face: FilesFace
}

function useModel(model: TreeModel): TreeSnapshot {
  return useSyncExternalStore(model.subscribe, model.getSnapshot)
}

/** Directories first, then by name, naturally and without case, as dsh's tree orders them. */
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function ordered(entries: readonly DirectoryEntry[]): DirectoryEntry[] {
  return [...entries].sort((left, right) => {
    const group = Number(right.type === 'directory') - Number(left.type === 'directory')
    return group !== 0 ? group : byName.compare(left.name, right.name)
  })
}

export function FilesBody({ useTabInfo, useSessions, sessionId, t, face }: FilesBodyProps) {
  const { tab, panel } = useTabInfo()
  const session = sessionOf(tab.contentId, sessionId)
  const cwd = useSessions(sessions => sessions.byId[session]?.cwd)
  const model = face.models.get(tab.id, tab.signal)
  const snapshot = useModel(model)
  const latest = useRef(tab)
  latest.current = tab
  const navigator = useRef<TreeNavigator | null>(null)
  navigator.current ??= face.navigator(session, () => latest.current)
  const origin = originOf(tab.contentId, cwd)
  const path = origin.kind === 'workspace' ? origin.root : origin.path
  const workspace = origin.kind === 'workspace' ? origin.root : origin.workspace
  const { revision } = tab.navigation
  const { phase } = snapshot
  const root = phase.kind === 'directory' ? phase.root : undefined
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void model.open(origin, navigator.current!)
    // The origin is rebuilt on every render; these values are what it holds.
  }, [model, origin.kind, path, workspace, revision])

  useEffect(() => {
    model.setVisible(tab.visible)
    return () => { model.setVisible(false) }
  }, [model, tab.visible])

  useEffect(() => tab.actions.bindCommands({ refresh: () => { model.refresh() } }), [tab.actions, model])

  useLayoutEffect(() => {
    if (scroller.current !== null) scroller.current.scrollTop = model.scrollTop
  }, [model, root])

  if (phase.kind === 'handed-off') return null
  if (phase.kind === 'probing') return <Status line={t('opening')} />
  if (phase.kind === 'no-workspace') return <Status line={t('noWorkspace')} />
  if (phase.kind === 'failed') return <Status line={refusalText(t, phase.refusal)} />
  if (phase.kind === 'unviewable') {
    return (
      <Status line={t('unviewable')}>
        <Download api={face.api} path={phase.path} archive={false} t={t} variant="button" />
      </Status>
    )
  }

  const parent = parentOf(phase.root)
  const tree: Tree = {
    snapshot,
    t,
    api: face.api,
    onToggle: (path) => { model.toggle(path) },
    onOpen: (path) => { face.openFile(session, cwd, path, panel.id) },
  }
  const reload = t(snapshot.stale ? 'reload.stale' : 'reload')
  return (
    <div className={css.root} data-mu-dsh-files={phase.root} data-mu-dsh-origin={origin.kind}>
      <div className={css.header}>
        <PathLabel path={phase.root} className={css.path} />
        {parent !== undefined && (
          <Tooltip label={t('up')} side="bottom" delayMs={500}>
            <button type="button" className={css.tool} aria-label={t('up')} data-mu-dsh-up
              onClick={() => { face.openFolder(tab, session, cwd, parent) }}>
              <IconChevronUpOutlineRegular />
            </button>
          </Tooltip>
        )}
        <Tooltip label={reload} shortcutKeys={tab.refreshShortcut?.keys} side="bottom" delayMs={500}>
          <button type="button" className={css.tool} aria-label={reload} aria-keyshortcuts={tab.refreshShortcut?.aria}
            data-mu-dsh-reload data-state={snapshot.stale ? 'stale' : undefined}
            onClick={() => { model.refresh() }}>
            <IconRefreshOutlineRegular />
          </button>
        </Tooltip>
        <Download api={face.api} path={phase.root} archive t={t} variant="tool" />
      </div>
      <div ref={scroller} className={css.body} onScroll={(event) => { model.scrollTop = event.currentTarget.scrollTop }}>
        <ul className={css.level}>
          <Level path={phase.root} tree={tree} />
        </ul>
      </div>
    </div>
  )
}

function Status({ line, children }: { line: string; children?: ReactNode }) {
  return (
    <div className={css.status} data-mu-dsh-status>
      <p className={css.statusLine}>{line}</p>
      {children}
    </div>
  )
}

interface Tree {
  readonly snapshot: TreeSnapshot
  readonly t: Translate
  readonly api: FilesApi
  onToggle(path: string): void
  onOpen(path: string): void
}

function Level({ path, tree }: { path: string; tree: Tree }) {
  const { snapshot, t } = tree
  const level = snapshot.levels[path]
  if (level === undefined || level.kind === 'loading') return <li className={css.note}>{t('loading')}</li>
  if (level.kind === 'failed') return <li className={css.note} data-mu-dsh-failed={level.refusal.error}>{refusalText(t, level.refusal)}</li>
  return (
    <>
      {level.failure !== undefined && <li className={css.note} data-mu-dsh-failed={level.failure.error}>{refusalText(t, level.failure)}</li>}
      {level.entries.length === 0 && <li className={css.note}>{t('empty')}</li>}
      {ordered(level.entries).map(entry => <Entry key={entry.name} parent={path} entry={entry} tree={tree} />)}
      {level.truncated && <li className={css.note}>{t('truncated')}</li>}
    </>
  )
}

function Entry({ parent, entry, tree }: { parent: string; entry: DirectoryEntry; tree: Tree }) {
  const path = childOf(parent, entry.name)
  const { t, api } = tree
  if (entry.type === 'directory') {
    const expanded = tree.snapshot.expanded.includes(path)
    return (
      <li className={css.item} data-mu-dsh-entry="directory" data-mu-dsh-path={path}>
        <div className={css.row}>
          <button type="button" className={css.rowMain} aria-expanded={expanded} onClick={() => { tree.onToggle(path) }}>
            {expanded ? <IconFolderOpenRegular className={css.icon} /> : <IconFolderCloseRegular className={css.icon} />}
            <span className={css.name}>{entry.name}</span>
          </button>
          <Download api={api} path={path} archive t={t} variant="row" />
        </div>
        {expanded && <ul className={css.level}><Level path={path} tree={tree} /></ul>}
      </li>
    )
  }
  if (entry.type === 'file') {
    return (
      <li className={css.item} data-mu-dsh-entry="file" data-mu-dsh-path={path}>
        <div className={css.row}>
          <button type="button" className={css.rowMain} onClick={() => { tree.onOpen(path) }}>
            <FileTypeIcon kind={classifyFileType(entry.name)} size={16} className={css.icon} />
            <span className={css.name}>{entry.name}</span>
            {entry.size !== undefined && <span className={css.size}>{fileSizeText(entry.size)}</span>}
          </button>
          <Download api={api} path={path} archive={false} t={t} variant="row" />
        </div>
      </li>
    )
  }
  return (
    <li className={css.item} data-mu-dsh-entry="other" data-mu-dsh-path={path}>
      <div className={css.row}>
        <span className={`${css.rowMain} ${css.other}`} aria-disabled="true" title={t('entry.other')}>
          <span className={css.name}>{entry.name}</span>
        </span>
      </div>
    </li>
  )
}

export interface FilesTitleProps {
  readonly useTabInfo: UseSidebarRightTabInfo
  readonly face: FilesFace
}

/**
 * A folder glyph for the Files page, and for a folder tab once its path is
 * known to be one; until then, the glyph its name suggests, as dsh's preview
 * chip shows.
 */
export function FilesTitle({ useTabInfo, face }: FilesTitleProps) {
  const { tab } = useTabInfo()
  const snapshot = useModel(face.models.get(tab.id, tab.signal))
  const folder = parseFileAddress(tab.contentId) === undefined || snapshot.phase.kind === 'directory'
  const icon = folder
    ? <FileTypeIcon kind="folder" size={16} className={css.titleIcon} />
    : <FileTypeIcon path={tab.title} size={16} className={css.titleIcon} />
  return <>{icon}{tab.title}</>
}
