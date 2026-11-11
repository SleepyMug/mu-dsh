/**
 * One folder tab's state, apart from React: what the opened address turned
 * out to be, and the levels of the tree under it.
 *
 * Every session file address comes to the folder type first (see index.ts),
 * so a tab starts by asking the host what its path is. A directory stays and
 * is listed; anything else is handed to the next viewer the sidebar ranks for
 * the address, which takes this tab's place. Only when no other viewer will
 * take it does the tab keep a file, and say so.
 *
 * Each listing request is numbered per path, and only the latest one for a
 * path may settle it, so a reload racing an expand cannot leave stale entries.
 */

import type { DirectoryEntry, Entry, Refusal } from '../wire.ts'
import type { Result } from './api.ts'
import { trimSlashes } from './paths.ts'

export type Level =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly entries: readonly DirectoryEntry[]; readonly truncated: boolean; readonly refreshing?: boolean }
  | { readonly kind: 'failed'; readonly refusal: Refusal }

export type Phase =
  | { readonly kind: 'probing' }
  | { readonly kind: 'directory'; readonly root: string }
  /** Given to another viewer, which replaces the tab. */
  | { readonly kind: 'handed-off' }
  /** A file no other viewer takes. */
  | { readonly kind: 'unviewable'; readonly path: string }
  /** Neither a directory nor anything another viewer takes. */
  | { readonly kind: 'failed'; readonly refusal: Refusal }

export interface FolderSnapshot {
  readonly phase: Phase
  readonly levels: Readonly<Record<string, Level>>
  readonly expanded: readonly string[]
}

/** What a folder tab asks of its surroundings. */
export interface FolderHost {
  entry(path: string, signal: AbortSignal): Promise<Result<Entry>>
  /** Give the tab's address to the next viewer in its place; `false` when there is none. */
  handOff(): boolean
}

const INITIAL: FolderSnapshot = { phase: { kind: 'probing' }, levels: {}, expanded: [] }

export class FolderModel {
  private snapshot: FolderSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private readonly generations = new Map<string, number>()
  private probeGeneration = 0
  private readonly signal: AbortSignal

  /** @param signal - the tab's lifetime; nothing settles after it aborts. */
  constructor(signal: AbortSignal) {
    this.signal = signal
  }

  readonly getSnapshot = (): FolderSnapshot => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private set(next: Partial<FolderSnapshot>): void {
    if (this.signal.aborted) return
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }

  private setLevel(path: string, level: Level): void {
    this.set({ levels: { ...this.snapshot.levels, [path]: level } })
  }

  /**
   * The tab was navigated to (opened, or its address opened again): find out
   * what the path is, or, for a directory already shown, list it again.
   * @param absolute - the address's absolute path; `undefined` when it cannot be known here.
   */
  async open(absolute: string | undefined, host: FolderHost): Promise<void> {
    const { phase } = this.snapshot
    if (phase.kind === 'directory' && absolute !== undefined && trimSlashes(absolute) === phase.root) {
      await this.refresh(host)
      return
    }
    const generation = ++this.probeGeneration
    this.set({ phase: { kind: 'probing' }, levels: {}, expanded: [] })
    if (absolute === undefined) {
      this.giveAway(host, undefined)
      return
    }
    const result = await host.entry(absolute, this.signal)
    if (this.signal.aborted || generation !== this.probeGeneration) return
    if (result.ok && result.value.type === 'directory') {
      const root = trimSlashes(result.value.path)
      this.generations.set(root, (this.generations.get(root) ?? 0) + 1)
      this.set({
        phase: { kind: 'directory', root },
        levels: { [root]: { kind: 'ready', entries: result.value.entries, truncated: result.value.truncated } },
      })
      return
    }
    this.giveAway(host, result)
  }

  private giveAway(host: FolderHost, probed: Result<Entry> | undefined): void {
    if (host.handOff()) {
      this.set({ phase: { kind: 'handed-off' } })
    } else if (probed === undefined) {
      this.set({ phase: { kind: 'failed', refusal: { error: 'bad-request', message: 'the workspace of this path is unknown' } } })
    } else if (probed.ok) {
      this.set({ phase: { kind: 'unviewable', path: probed.value.path } })
    } else {
      this.set({ phase: { kind: 'failed', refusal: probed.refusal } })
    }
  }

  /** Expand a directory row (listing it) or collapse it. */
  async toggle(path: string, host: FolderHost): Promise<void> {
    const { expanded } = this.snapshot
    if (expanded.includes(path)) {
      this.set({ expanded: expanded.filter(p => p !== path) })
      return
    }
    this.set({ expanded: [...expanded, path] })
    await this.list(path, host)
  }

  /** List the root and every expanded directory again, keeping what is shown until each answers. */
  async refresh(host: FolderHost): Promise<void> {
    const { phase, expanded } = this.snapshot
    if (phase.kind !== 'directory') return
    await Promise.all([phase.root, ...expanded].map(path => this.list(path, host)))
  }

  private async list(path: string, host: FolderHost): Promise<void> {
    const generation = (this.generations.get(path) ?? 0) + 1
    this.generations.set(path, generation)
    const shown = this.snapshot.levels[path]
    this.setLevel(path, shown?.kind === 'ready' ? { ...shown, refreshing: true } : { kind: 'loading' })
    const result = await host.entry(path, this.signal)
    if (this.signal.aborted || this.generations.get(path) !== generation) return
    if (!result.ok) {
      this.setLevel(path, { kind: 'failed', refusal: result.refusal })
    } else if (result.value.type !== 'directory') {
      this.setLevel(path, { kind: 'failed', refusal: { error: 'not-regular', message: `${path} is no longer a directory` } })
    } else {
      this.setLevel(path, { kind: 'ready', entries: result.value.entries, truncated: result.value.truncated })
    }
  }
}

/** Each folder tab's model, by tab id, for as long as the tab lives. */
export class FolderModels {
  private readonly byTab = new Map<string, FolderModel>()

  get(tabId: string, signal: AbortSignal): FolderModel {
    let model = this.byTab.get(tabId)
    if (signal.aborted) return model ?? new FolderModel(signal) // an ended tab keeps nothing
    if (model === undefined) {
      model = new FolderModel(signal)
      this.byTab.set(tabId, model)
      signal.addEventListener('abort', () => { this.byTab.delete(tabId) }, { once: true })
    }
    return model
  }

  peek(tabId: string): FolderModel | undefined {
    return this.byTab.get(tabId)
  }
}
