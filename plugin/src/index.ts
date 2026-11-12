/**
 * mu-dsh-files, host half: the routes the browser half calls. Each is an
 * exact route on dsh's `/api` channel, so dsh authenticates every request
 * (only the profile's owner reaches them) before the handler runs, and each
 * goes through `ctx.fs`, so it sees exactly what dsh's own file preview may.
 *
 * The routes wait for the web connection: in a profile without one, such as
 * `headless`, the plugin loads and does nothing.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-fs'
import { download } from './download.ts'
import { entry } from './entry.ts'
import { Watches } from './watch.ts'
import { DOWNLOAD_PATH, ENTRY_PATH, WATCH_PATH } from './wire.ts'

export const name = 'mu-dsh-files'

export function apply(ctx: Context): void {
  ctx.inject(['connection', 'fs'], (ctx) => {
    ctx.effect(() => ctx.connection.fetch.register({
      path: ENTRY_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: request => entry(ctx.fs, request),
    }), 'mu-dsh-files: entry route')
    ctx.effect(() => ctx.connection.fetch.register({
      path: DOWNLOAD_PATH,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: request => download(ctx.fs, request),
    }), 'mu-dsh-files: download route')
    ctx.effect(() => {
      const watches = new Watches(ctx.fs)
      const route = ctx.connection.fetch.register({
        path: WATCH_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: async request => watches.fetch(request),
      })
      return () => {
        route()
        void watches.close()
      }
    }, 'mu-dsh-files: watch route')
  })
}
