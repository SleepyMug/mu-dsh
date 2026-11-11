/**
 * A download control: asks the host first (HEAD) so a refusal shows here
 * rather than as a failed download in the browser, then hands the URL to the
 * browser's download manager, which streams it to disk.
 */

import { useEffect, useRef, useState } from 'react'
import { Button, IconArchiveOutlineRegular, IconDownloadOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { Refusal } from '../wire.ts'
import { saveUrl, type FilesApi } from './api.ts'
import type { NS } from './locales.ts'
import { css } from './styles.ts'

export type Translate = TranslateNS<typeof NS>

/** How long a refusal stays shown. */
const REFUSAL_MS = 6000

export function refusalText(t: Translate, refusal: Refusal): string {
  return refusal.error === 'unavailable' ? t('error.unavailable', { message: refusal.message }) : t(`error.${refusal.error}`)
}

/** The reason, and what the host said about it when that says more (such as which directory it could not read). */
function refusalDetail(t: Translate, refusal: Refusal): string {
  const reason = refusalText(t, refusal)
  return refusal.error === 'unavailable' || /^HTTP \d+$/.test(refusal.message) ? reason : `${reason} (${refusal.message})`
}

type State = { readonly kind: 'idle' } | { readonly kind: 'checking' } | { readonly kind: 'refused'; readonly message: string }

function useDownload(api: FilesApi, path: string, t: Translate): { state: State; start: () => void } {
  const [state, setState] = useState<State>({ kind: 'idle' })
  const pending = useRef<AbortController | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    pending.current?.abort()
    clearTimeout(timer.current)
  }, [])
  const start = (): void => {
    pending.current?.abort()
    clearTimeout(timer.current)
    const controller = new AbortController()
    pending.current = controller
    setState({ kind: 'checking' })
    api.check(path, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (result.ok) {
        saveUrl(result.value)
        setState({ kind: 'idle' })
        return
      }
      setState({ kind: 'refused', message: t('download.failed', { message: refusalDetail(t, result.refusal) }) })
      timer.current = setTimeout(() => { setState({ kind: 'idle' }) }, REFUSAL_MS)
    }, () => {
      // Aborted: a newer click or the control's unmount owns the state now.
    })
  }
  return { state, start }
}

export interface DownloadProps {
  readonly api: FilesApi
  readonly path: string
  /** A directory, downloaded as a ZIP archive. */
  readonly archive: boolean
  readonly t: Translate
  /** `tool`: an icon in a header; `row`: an icon on a tree row; `button`: a labelled button. */
  readonly variant: 'tool' | 'row' | 'button'
}

export function Download({ api, path, archive, t, variant }: DownloadProps) {
  const { state, start } = useDownload(api, path, t)
  const label = t(archive ? 'download.zip' : 'download')
  const icon = archive ? <IconArchiveOutlineRegular /> : <IconDownloadOutlineRegular />
  const refused = state.kind === 'refused' ? <span className={css.bubble} role="status">{state.message}</span> : null
  if (variant === 'button') {
    return (
      <span className={css.anchor}>
        <Button variant="outline" size="sm" icon={icon} disabled={state.kind === 'checking'} onClick={start} data-mu-dsh-download={path}>
          {label}
        </Button>
        {refused}
      </span>
    )
  }
  return (
    <span className={variant === 'row' ? `${css.anchor} ${css.rowTool}` : css.anchor} data-state={state.kind === 'idle' ? undefined : state.kind}>
      <Tooltip label={label} side="bottom" delayMs={500}>
        <button
          type="button"
          className={css.tool}
          aria-label={label}
          disabled={state.kind === 'checking'}
          data-state={state.kind === 'idle' ? undefined : state.kind}
          data-mu-dsh-download={path}
          onClick={(event) => {
            event.stopPropagation()
            start()
          }}
        >
          {icon}
        </button>
      </Tooltip>
      {refused}
    </span>
  )
}

/** The props dsh's preview and file tree seats give their contributions. */
export interface PathOwnerProps {
  readonly absolutePath: string
  readonly api: FilesApi
  readonly t: Translate
}

/** In the file preview's header. */
export function PreviewDownload({ absolutePath, api, t }: PathOwnerProps) {
  return <Download api={api} path={absolutePath} archive={false} t={t} variant="tool" />
}

/** Where the file preview cannot render a file. */
export function UnpreviewableDownload({ absolutePath, api, t }: PathOwnerProps) {
  return <Download api={api} path={absolutePath} archive={false} t={t} variant="button" />
}

/** In dsh's Files tree header: the workspace as an archive. */
export function WorkspaceDownload({ absolutePath, api, t }: PathOwnerProps) {
  return <Download api={api} path={absolutePath} archive t={t} variant="tool" />
}
