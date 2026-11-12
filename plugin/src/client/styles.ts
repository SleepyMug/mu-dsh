/**
 * The browser half's styles, in one style element. dsh's module loader removes
 * a plugin's `<style data-plugin>` elements with the plugin; the remover
 * `addStyles` returns does the same when the plugin's parts are disposed
 * without it being unloaded. The values follow dsh's own file tree and
 * preview header.
 */

const PLUGIN = 'mu-dsh-files'
const TAG = `${PLUGIN}/styles.css`

export const css = {
  root: 'mdf-root',
  header: 'mdf-header',
  path: 'mdf-path',
  tool: 'mdf-tool',
  body: 'mdf-body',
  level: 'mdf-level',
  item: 'mdf-item',
  row: 'mdf-row',
  rowMain: 'mdf-row-main',
  rowTool: 'mdf-row-tool',
  icon: 'mdf-icon',
  name: 'mdf-name',
  size: 'mdf-size',
  other: 'mdf-other',
  note: 'mdf-note',
  status: 'mdf-status',
  statusLine: 'mdf-status-line',
  titleIcon: 'mdf-title-icon',
  anchor: 'mdf-anchor',
  bubble: 'mdf-bubble',
  emptyAction: 'mdf-empty-action',
}

const TEXT = `
.mdf-root{height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5;display:flex;flex:auto;flex-direction:column}
.mdf-header{box-sizing:border-box;border-bottom:.5px solid var(--dsw-alias-border-l3);flex:none;align-items:center;gap:4px;height:38px;padding:0 6px 0 16px;display:flex}
.mdf-path{margin-right:auto;min-width:0}
.mdf-tool{width:28px;height:28px;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);cursor:pointer;background:0 0;border:none;flex:none;justify-content:center;align-items:center;padding:6px;line-height:1;display:inline-flex}
.mdf-tool svg{width:15px;height:15px}
.mdf-tool:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.mdf-tool:disabled{opacity:.5;cursor:default}
.mdf-tool[data-state=refused]{color:var(--dsw-alias-state-error,#d93025)}
.mdf-tool[data-state=stale]{position:relative}
.mdf-tool[data-state=stale]::after{content:'';position:absolute;top:5px;right:5px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warning,#e8a317)}
.mdf-body{scrollbar-gutter:stable;flex:auto;min-height:0;margin-right:2px;padding:8px 0 8px 8px;overflow:auto}
.mdf-level{margin:0;padding:0;list-style:none}
.mdf-level .mdf-level{padding-left:18px}
.mdf-item{margin:0;padding:0}
.mdf-row{display:flex;align-items:center;border-radius:var(--dsw-radius-md);min-width:0}
.mdf-row:hover,.mdf-row:focus-within{background:var(--dsw-alias-interactive-bg-hover)}
.mdf-row-main{flex:auto;min-width:0;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;align-items:center;gap:6px;padding:5px 10px;display:flex}
.mdf-row-tool{visibility:hidden;margin-right:4px}
.mdf-row:hover .mdf-row-tool,.mdf-row:focus-within .mdf-row-tool,.mdf-row-tool[data-state]{visibility:visible}
.mdf-icon{color:var(--dsw-alias-label-tertiary);flex:none}
.mdf-name{white-space:nowrap;text-overflow:ellipsis;min-width:0;overflow:hidden}
.mdf-size{color:var(--dsw-alias-label-tertiary);margin-left:auto;padding-left:8px;font-size:12px;white-space:nowrap}
.mdf-other{color:var(--dsw-alias-label-tertiary);cursor:default}
.mdf-note{color:var(--dsw-alias-label-tertiary);margin:0;padding:3px 10px;font-size:12px}
.mdf-status{flex-direction:column;align-items:flex-start;gap:8px;padding:12px 16px;display:flex}
.mdf-status-line{color:var(--dsw-alias-label-secondary);margin:0;line-height:1.6}
.mdf-title-icon{flex:none}
.mdf-anchor{position:relative;display:inline-flex;flex:none}
.mdf-bubble{position:absolute;top:calc(100% + 4px);right:0;z-index:10;width:max-content;max-width:280px;padding:6px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:0 2px 12px rgba(0,0,0,.16);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;white-space:normal}
.mdf-empty-action{margin-top:4px}
`

export function addStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG)}]`)
  if (existing !== null) return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = PLUGIN
  tag.dataset.pluginCss = TAG
  tag.textContent = TEXT
  document.head.appendChild(tag)
  return () => { tag.remove() }
}
