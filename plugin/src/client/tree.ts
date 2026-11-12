/**
 * One Files tab's state, apart from React: what the tab shows, and the levels
 * of the tree under it.
 *
 * A tab is opened one of two ways. Opened as the Files page (by kind, as the
 * guide and dsh's Files shortcut do), it shows the session's working
 * directory. Opened by address (a link in the conversation), it first asks
 * the host what the path is, because a link cannot say whether it names a
 * file or a folder and every session file address comes to this tab type
 * first (see index.ts). A directory stays and is shown as a tree, except the
 * working directory itself, which becomes the Files page. Anything else goes
 * to the next viewer the sidebar ranks for the address, which takes the tab's
 * place; only a file no other viewer takes stays, and the tab says so.
 *
 * While the tab is visible the tree follows the disk: every directory it
 * shows open is watched and listed again when it changes. Listings of one
 * directory never overlap. A change during one asks for one more after it,
 * so the last listing always starts after the last change.
 */

import type { DirectoryEntry, Entry, Refusal } from '../wire.ts'
import type { Result } from './api.ts'
import { childOf, trimSlashes } from './paths.ts'
import type { Watcher, WatchSignal } from './watch.ts'

export type Origin =
  /** The Files page: the session's working directory; `undefined` for a session without one. */
  | { readonly kind: 'workspace'; readonly root: string | undefined }
  /** A file address: its absolute path (`undefined` when it cannot be known here), and its session's working directory. */
  | { readonly kind: 'address'; readonly path: string | undefined; readonly workspace: string | undefined }

export type Level =
  | { readonly kind: 'loading' }
  | {
    readonly kind: 'ready'
    readonly entries: readonly DirectoryEntry[]
    readonly truncated: boolean
    /** The last listing failed for a reason that says nothing about the directory (the host was unreachable, say); the entries are the ones before. */
    readonly failure?: Refusal
  }
  | { readonly kind: 'failed'; readonly refusal: Refusal }

export type Phase =
  | { readonly kind: 'probing' }
  | { readonly kind: 'directory'; readonly root: string }
  /** The Files page of a session without a working directory. */
  | { readonly kind: 'no-workspace' }
  /** Given to another viewer, or to the Files page, which replaces the tab. */
  | { readonly kind: 'handed-off' }
  /** A file no other viewer takes. */
  | { readonly kind: 'unviewable'; readonly path: string }
  /** Neither a directory nor anything another viewer takes. */
  | { readonly kind: 'failed'; readonly refusal: Refusal }

export interface TreeSnapshot {
  readonly phase: Phase
  /** By absolute path; a path absent here was never listed. */
  readonly levels: Readonly<Record<string, Level>>
  /** Directories the reader opened, kept while an ancestor is closed so that reopening it restores them. */
  readonly expanded: readonly string[]
  /** Some directory shown open is not watched for now, so changes to it may not show by themselves. */
  readonly stale: boolean
}

/** What every tree uses: the host's listings and the page's watches. */
export interface TreeDeps {
  entry(path: string, signal: AbortSignal): Promise<Result<Entry>>
  readonly watcher: Watcher
}

/** What a tab may do in the sidebar, as its body supplies it. */
export interface TreeNavigator {
  /** Give the tab's address to the next viewer, in the tab's place; `false` when there is none. */
  handOff(): boolean
  /** Open the Files page in the tab's place. */
  toWorkspace(): void
}

const INITIAL: TreeSnapshot = { phase: { kind: 'probing' }, levels: {}, expanded: [], stale: false }

export class TreeModel {
  private snapshot: TreeSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private readonly signal: AbortSignal
  private readonly deps: TreeDeps
  /** Bumped whenever the tree is reset, so that nothing begun for the old one settles the new one. */
  private epoch = 0
  /** Listings running, by path; `again` asks for one more after the current. */
  private reading = new Map<string, { again: boolean }>()
  private readonly watches = new Map<string, () => void>()
  /** Watched paths whose watch is lost for now. */
  private readonly lost = new Set<string>()
  private visible = false
  /** Where the reader left the tree scrolled, for when the body is drawn again. */
  scrollTop = 0

  /** @param signal - the tab's lifetime; nothing settles, and nothing is watched, after it aborts. */
  constructor(signal: AbortSignal, deps: TreeDeps) {
    this.signal = signal
    this.deps = deps
    signal.addEventListener('abort', () => { this.follow() }, { once: true })
  }

  readonly getSnapshot = (): TreeSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * The tab was navigated to (opened, or opened again): find out what it
   * shows, or, for the directory already shown, list it again.
   */
  async open(origin: Origin, navigator: TreeNavigator): Promise<void> {
    const path = origin.kind === 'workspace' ? origin.root : origin.path
    const { phase } = this.snapshot
    if (phase.kind === 'directory' && path !== undefined && trimSlashes(path) === phase.root) {
      this.refresh()
      return
    }
    const epoch = this.reset({ kind: 'probing' })
    if (origin.kind === 'workspace' && origin.root === undefined) {
      this.set({ phase: { kind: 'no-workspace' } })
      return
    }
    if (path === undefined) {
      this.giveAway(navigator, undefined)
      return
    }
    const result = await this.read(path)
    if (result === undefined || epoch !== this.epoch) return
    if (result.ok && result.value.type === 'directory') {
      const root = trimSlashes(result.value.path)
      if (origin.kind === 'address' && origin.workspace !== undefined && root === trimSlashes(origin.workspace)) {
        this.set({ phase: { kind: 'handed-off' } })
        navigator.toWorkspace()
        return
      }
      this.set({ phase: { kind: 'directory', root }, levels: { [root]: levelOf(result.value) } })
      return
    }
    if (origin.kind === 'workspace') {
      const refusal = result.ok ? { error: 'not-regular', message: `${path} is not a directory` } as const : result.refusal
      this.set({ phase: { kind: 'failed', refusal } })
      return
    }
    this.giveAway(navigator, result)
  }

  /** Open a directory row (listing it) or close it. */
  toggle(path: string): void {
    const { expanded } = this.snapshot
    if (expanded.includes(path)) {
      this.set({ expanded: expanded.filter(p => p !== path) })
      return
    }
    this.set({ expanded: [...expanded, path] })
    this.list(path)
  }

  /** List every directory shown open again, keeping what is shown until each answers. */
  refresh(): void {
    for (const path of this.shown()) this.list(path)
  }

  /** Follow the disk while the tab can be seen; a tab seen again is listed again as its watches stand. */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return
    this.visible = visible
    this.set({})
  }

  /** Change the snapshot, then watch what it shows. */
  private set(next: Partial<TreeSnapshot>): void {
    if (this.signal.aborted) return
    this.snapshot = { ...this.snapshot, ...next }
    this.follow()
    const stale = this.lost.size > 0
    if (stale !== this.snapshot.stale) this.snapshot = { ...this.snapshot, stale }
    for (const listener of this.listeners) listener()
  }

  private setLevel(path: string, level: Level): void {
    this.set({ levels: { ...this.snapshot.levels, [path]: level } })
  }

  private reset(phase: Phase): number {
    this.epoch += 1
    this.reading = new Map()
    this.scrollTop = 0
    this.set({ phase, levels: {}, expanded: [] })
    return this.epoch
  }

  private giveAway(navigator: TreeNavigator, probed: Result<Entry> | undefined): void {
    if (navigator.handOff()) {
      this.set({ phase: { kind: 'handed-off' } })
    } else if (probed === undefined) {
      this.set({ phase: { kind: 'failed', refusal: { error: 'bad-request', message: 'the workspace of this path is unknown' } } })
    } else if (probed.ok) {
      this.set({ phase: { kind: 'unviewable', path: probed.value.path } })
    } else {
      this.set({ phase: { kind: 'failed', refusal: probed.refusal } })
    }
  }

  /** The host's answer for a path; `undefined` once the tab has ended. */
  private async read(path: string): Promise<Result<Entry> | undefined> {
    try {
      return await this.deps.entry(path, this.signal)
    } catch (error) {
      if (this.signal.aborted) return undefined
      throw error
    }
  }

  private list(path: string): void {
    const running = this.reading.get(path)
    if (running !== undefined) {
      running.again = true
      return
    }
    void this.listing(path)
  }

  private async listing(path: string): Promise<void> {
    const epoch = this.epoch
    const run = { again: false }
    const reading = this.reading
    reading.set(path, run)
    if (this.snapshot.levels[path] === undefined) this.setLevel(path, { kind: 'loading' })
    try {
      do {
        run.again = false
        const result = await this.read(path)
        if (result === undefined || epoch !== this.epoch) return
        this.setLevel(path, this.settled(path, result))
      } while (run.again)
    } finally {
      if (reading.get(path) === run) reading.delete(path)
    }
  }

  private settled(path: string, result: Result<Entry>): Level {
    if (result.ok) {
      if (result.value.type === 'directory') return levelOf(result.value)
      return { kind: 'failed', refusal: { error: 'not-regular', message: `${path} is no longer a directory` } }
    }
    const shown = this.snapshot.levels[path]
    if (shown?.kind === 'ready' && result.refusal.error === 'unavailable') {
      return { kind: 'ready', entries: shown.entries, truncated: shown.truncated, failure: result.refusal }
    }
    return { kind: 'failed', refusal: result.refusal }
  }

  /** The directories shown open: the root, and each opened directory every ancestor of which is open and listed. */
  private shown(): string[] {
    const { phase, levels, expanded } = this.snapshot
    if (phase.kind !== 'directory') return []
    const open = new Set(expanded)
    const shown: string[] = []
    const visit = (path: string): void => {
      shown.push(path)
      const level = levels[path]
      if (level?.kind !== 'ready') return
      for (const entry of level.entries) {
        const child = childOf(path, entry.name)
        if (entry.type === 'directory' && open.has(child)) visit(child)
      }
    }
    visit(phase.root)
    return shown
  }

  /** Watch exactly the directories shown open, while the tab is visible and alive. */
  private follow(): void {
    const wanted = new Set(this.visible && !this.signal.aborted ? this.shown() : [])
    for (const [path, stop] of this.watches) {
      if (wanted.has(path)) continue
      stop()
      this.watches.delete(path)
      this.lost.delete(path)
    }
    for (const path of wanted) {
      if (!this.watches.has(path)) this.watches.set(path, this.deps.watcher.watch(path, signal => { this.heard(path, signal) }))
    }
  }

  private heard(path: string, signal: WatchSignal): void {
    if (!this.watches.has(path)) return
    const wasLost = this.lost.has(path)
    if (signal === 'lost') this.lost.add(path)
    else if (signal === 'ready') this.lost.delete(path)
    if (this.lost.has(path) !== wasLost) this.set({})
    if (signal !== 'lost') this.list(path)
  }
}

function levelOf(directory: Extract<Entry, { type: 'directory' }>): Level {
  return { kind: 'ready', entries: directory.entries, truncated: directory.truncated }
}

/** Each Files tab's model, by tab id, for as long as the tab lives. */
export class TreeModels {
  private readonly byTab = new Map<string, TreeModel>()
  private readonly deps: TreeDeps

  constructor(deps: TreeDeps) {
    this.deps = deps
  }

  get(tabId: string, signal: AbortSignal): TreeModel {
    let model = this.byTab.get(tabId)
    if (signal.aborted) return model ?? new TreeModel(signal, this.deps) // an ended tab keeps nothing
    if (model === undefined) {
      model = new TreeModel(signal, this.deps)
      this.byTab.set(tabId, model)
      signal.addEventListener('abort', () => { this.byTab.delete(tabId) }, { once: true })
    }
    return model
  }
}
