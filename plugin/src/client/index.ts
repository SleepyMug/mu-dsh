/**
 * mu-dsh-files, browser half: a Files tab that takes over dsh's own.
 *
 * The tab type registers dsh's Files kind, `files`, in the `extension` band,
 * which the sidebar puts in force over the built-in one for as long as it is
 * registered: dsh's guide entry and Files shortcut, which open the kind, open
 * this one, and should this plugin fail or unload, dsh's own Files tab
 * resumes. Opened by kind, the tab shows the session's working directory.
 *
 * The type also claims every session file address, above dsh's own viewers:
 * a link cannot say whether it names a file or a folder, and the sidebar must
 * pick a tab type before anything can ask the host. Such a tab therefore
 * starts by asking (see tree.ts). A directory stays and is shown as a tree;
 * anything else is reopened in the tab's place with the best viewer the
 * sidebar ranks after this one, carrying the navigation (such as a line to
 * show) with it.
 *
 * It also puts download controls on dsh's file preview header, on the
 * preview's "cannot show this" state, and on dsh's own Files header (the
 * workspace as an archive) for when that is in force.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { ShortcutCommandId } from '@deepseek-ai/dsh-client-shortcuts/client'
import { GuideArtworkFiles } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import type { SidebarRightOpenResourceOptions, SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { fileAddressFor, parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { FilesApi } from './api.ts'
import { PreviewDownload, UnpreviewableDownload, WorkspaceDownload } from './Download.tsx'
import { FilesBody, FilesTitle, type FilesFace, type Tab } from './Files.tsx'
import { NS, en, zh } from './locales.ts'
import { FILE_ADDRESS_PATTERN, titleOf, trimSlashes } from './paths.ts'
import { addStyles } from './styles.ts'
import { TreeModels } from './tree.ts'
import { WatchHub } from './watch.ts'

/** This implementation's identity in the tab system, and the key its body and title register under. */
export const FILES_ID = 'mu-dsh-files'
/** dsh's Files kind, which this type takes over. */
export const FILES_KIND = 'files'
/** dsh's Files shortcut, which the built-in Files plugin registers; the guide entry shows its binding. */
const FILES_COMMAND = 'workspace.files' as ShortcutCommandId

/** What the plugin uses of dsh's web client. */
const SERVICES = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight', 'sessions']

/**
 * The plugin itself waits for nothing and cannot fail: dsh's web client shows
 * no UI at all while any plugin is pending or failed. Its parts live in a
 * scope of their own that waits for the services they use, so on a dsh whose
 * client lacks one, or whose API no longer fits, that scope fails alone (and
 * cordis undoes whatever it had registered) while dsh's UI starts without it.
 */
export function apply(ctx: Context): void {
  ctx.inject(SERVICES, (ctx) => {
    try {
      install(ctx)
    } catch (error) {
      console.error('mu-dsh-files: not available in this dsh:', error)
      throw error
    }
  })
}

function install(ctx: Context): void {
  ctx.effect(() => addStyles(), 'mu-dsh-files: styles')
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'mu-dsh-files: dictionaries')
  const t = ctx.locale.bind(NS)

  const api = new FilesApi(() => document.baseURI)
  const watcher = new WatchHub({ events: signal => api.watchEvents(signal), control: control => api.watchControl(control) })
  ctx.effect(() => () => { watcher.dispose() }, 'mu-dsh-files: watches')
  const models = new TreeModels({ entry: (path, signal) => api.entry(path, signal), watcher })
  const cwdOf = (sessionId: string): string | undefined => ctx.sessions.list.getSnapshot().byId[sessionId as SessionId]?.cwd

  const definition: SidebarRightTabDefinition = {
    id: FILES_ID,
    kind: FILES_KIND,
    patterns: [FILE_ADDRESS_PATTERN],
    priority: 'extension',
    // The file preview, which this hands files to, opens Session addresses only.
    canOpen: address => parseFileAddress(address)?.scope === 'session',
    // Opened by kind, the tab has a page address, which is no file address.
    title: address => parseFileAddress(address) === undefined ? t('type.label') : titleOf(address, cwdOf),
    guide: [{
      // dsh's own entry id, so that a choice to pin or unpin it carries over.
      id: 'workspace',
      commandId: FILES_COMMAND,
      order: 10,
      title: () => t('guide.title'),
      description: () => t('guide.description'),
      icon: GuideArtworkFiles,
    }],
  }

  /** The kind the sidebar would open an address with if this type were not there. */
  const nextKind = (address: string): string | undefined =>
    ctx.sidebarRightTabs.candidates(address).find(candidate => candidate.id !== FILES_ID)?.kind

  const open = (sessionId: SessionId, address: string, options: SidebarRightOpenResourceOptions): boolean => {
    const kind = nextKind(address)
    if (kind === undefined) return false
    ctx.sidebarRight.openResourceIn(sessionId, address, { ...options, kind })
    return true
  }

  const face: FilesFace = {
    models,
    api,
    navigator: (sessionId, tab) => ({
      handOff: () => {
        const current: Tab = tab()
        if (current.signal.aborted) return true
        // A tab opened by address carries resource navigation, which the next viewer takes as its own.
        const params = current.navigation.params as SidebarRightOpenResourceOptions['params']
        return open(sessionId, current.contentId, { replaceTab: current.id, params })
      },
      toWorkspace: () => {
        const current: Tab = tab()
        if (!current.signal.aborted) current.actions.openTab(FILES_KIND, { replaceTab: true })
      },
    }),
    openFile: (sessionId, cwd, path, paneId) => {
      const address = fileAddressFor(sessionId, cwd, path)
      const placement = { paneId: paneId as SidebarRightOpenResourceOptions['paneId'] }
      // A file no other viewer takes opens here, which offers to download it.
      if (!open(sessionId, address, placement)) ctx.sidebarRight.openResourceIn(sessionId, address, { ...placement, kind: FILES_KIND })
    },
    openFolder: (tab, sessionId, cwd, path) => {
      if (cwd !== undefined && cwd !== '' && trimSlashes(path) === trimSlashes(cwd)) {
        tab.actions.openTab(FILES_KIND, { replaceTab: true })
      } else {
        tab.actions.openResource(fileAddressFor(sessionId, cwd, path), { replaceTab: true })
      }
    },
  }

  // The type takes over every Files tab, so it exists exactly while its body does.
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => contained('the Files tab', () => {
    const body = ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: FILES_ID,
      locale: NS,
      inject: () => ({ face }),
    }, FilesBody)
    try {
      const type = ctx.sidebarRightTabs.register(definition)
      return () => {
        type()
        body()
      }
    } catch (error) {
      body()
      throw error
    }
  })), 'mu-dsh-files: Files type and body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => contained('the Files tab title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: FILES_ID,
    inject: () => ({ face }),
  }, FilesTitle))), 'mu-dsh-files: Files title')

  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => contained('the preview download', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions',
    id: 'mu-dsh-files',
    locale: NS,
    inject: () => ({ api }),
  }, PreviewDownload))), 'mu-dsh-files: preview download')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.unpreviewable', () => contained('the unpreviewable download', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.unpreviewable',
    id: 'mu-dsh-files',
    locale: NS,
    inject: () => ({ api }),
  }, UnpreviewableDownload))), 'mu-dsh-files: unpreviewable download')
  // Drawn only while dsh's own Files tab is in force, which declares this seat.
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.files.actions', () => contained('the workspace download', () => ctx.slots.register({
    name: 'sidebar.right.tab.files.actions',
    id: 'mu-dsh-files',
    locale: NS,
    inject: () => ({ api }),
  }, WorkspaceDownload))), 'mu-dsh-files: workspace download')
}

/**
 * Run one registration into another plugin's slot so that its failure stays
 * here: logged and left undone, never thrown into the plugin declaring the
 * slot, whose own activation it would otherwise fail.
 */
function contained(what: string, register: () => () => void): () => void {
  try {
    return register()
  } catch (error) {
    console.error(`mu-dsh-files: ${what} is not available:`, error)
    return () => {}
  }
}
