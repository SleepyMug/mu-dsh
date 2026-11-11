/**
 * mu-dsh-files, browser half.
 *
 * The folder tab type claims every session file address in the right
 * sidebar, at the `extension` band, above dsh's own viewers: a link cannot
 * say whether it names a file or a folder, and the sidebar must pick a tab
 * type before anything can ask the host. A folder tab therefore starts by
 * asking (see folder.ts). A directory stays and is shown as a tree; anything
 * else is reopened in the tab's place with the best viewer the sidebar ranks
 * after this one, carrying the navigation (such as a line to show) with it.
 *
 * It also puts download controls on dsh's file preview header, on the
 * preview's "cannot show this" state, and on the Files tree header (the
 * workspace as an archive).
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-files/client'
import type { SidebarRightOpenResourceOptions, SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { fileAddressFor, parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import { FilesApi } from './api.ts'
import { PreviewDownload, UnpreviewableDownload, WorkspaceDownload } from './Download.tsx'
import { FolderBody, FolderTitle, type FolderFace, type Tab } from './Folder.tsx'
import { FolderModels } from './folder.ts'
import { NS, en, zh } from './locales.ts'
import { titleOf } from './paths.ts'
import { addStyles } from './styles.ts'

/** This implementation's identity in the tab system, and the key its body and title register under. */
export const FOLDER_ID = 'mu-dsh-files/folder'
export const FOLDER_KIND = 'mu-dsh-files.folder'

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

  const api = new FilesApi(() => document.baseURI)
  const models = new FolderModels()
  const cwdOf = (sessionId: string): string | undefined => ctx.sessions.list.getSnapshot().byId[sessionId as SessionId]?.cwd

  const definition: SidebarRightTabDefinition = {
    id: FOLDER_ID,
    kind: FOLDER_KIND,
    patterns: ['dsh-resource://file/**'],
    priority: 'extension',
    // The file preview, which this hands files to, opens Session addresses only.
    canOpen: address => parseFileAddress(address)?.scope === 'session',
    title: address => titleOf(address, cwdOf),
  }

  /** The kind the sidebar would open an address with if the folder type were not there. */
  const nextKind = (address: string): string | undefined =>
    ctx.sidebarRightTabs.candidates(address).find(candidate => candidate.id !== FOLDER_ID)?.kind

  const open = (sessionId: SessionId, address: string, options: SidebarRightOpenResourceOptions): boolean => {
    const kind = nextKind(address)
    if (kind === undefined) return false
    ctx.sidebarRight.openResourceIn(sessionId, address, { ...options, kind })
    return true
  }

  const face: FolderFace = {
    models,
    api,
    host: (sessionId, tab) => ({
      entry: (path, signal) => api.entry(path, signal),
      handOff: () => {
        const current: Tab = tab()
        if (current.signal.aborted) return true
        // A tab opened by address carries resource navigation, which the next viewer takes as its own.
        const params = current.navigation.params as SidebarRightOpenResourceOptions['params']
        return open(sessionId, current.contentId, { replaceTab: current.id, params })
      },
    }),
    openFile: (sessionId, cwd, path, paneId) => {
      const address = fileAddressFor(sessionId, cwd, path)
      if (!open(sessionId, address, { paneId: paneId as SidebarRightOpenResourceOptions['paneId'] })) {
        ctx.sidebarRight.openResourceIn(sessionId, address, { kind: FOLDER_KIND, paneId: paneId as SidebarRightOpenResourceOptions['paneId'] })
      }
    },
    openFolder: (tab, sessionId, cwd, path) => {
      tab.actions.openResource(fileAddressFor(sessionId, cwd, path), { replaceTab: true })
    },
  }

  // The type claims every file address, so it exists exactly while its body does.
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => contained('the folder tab', () => {
    const body = ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: FOLDER_ID,
      locale: NS,
      inject: () => ({ face }),
    }, FolderBody)
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
  })), 'mu-dsh-files: folder type and body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => contained('the folder tab title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title',
    key: FOLDER_ID,
    inject: () => ({ face }),
  }, FolderTitle))), 'mu-dsh-files: folder title')

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
