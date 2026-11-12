// Built by plugin/build.mjs from plugin/src; edit the sources, not this file.
window.__ModuleLoader__.load({
	id: "mu-dsh-files",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.ts
var index_exports = {};
__export(index_exports, {
  FILES_ID: () => FILES_ID,
  FILES_KIND: () => FILES_KIND,
  apply: () => apply
});
module.exports = __toCommonJS(index_exports);
var import_dsh_client_ui_primitives3 = require("@deepseek-ai/dsh-client-ui-primitives");

// node_modules/.pnpm/@deepseek-ai+dsh-util-workspace-path@0.2.1-rc.5_@deepseek-ai+cordis@4.0.5/node_modules/@deepseek-ai/dsh-util-workspace-path/lib/index.js
var FILE_ADDRESS_PREFIX = "dsh-resource://file/";
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(/%3A/gi, ":");
}
function encodePath(path) {
  return path.split("/").map(encodeSegment).join("/");
}
function isDriveSegment(segment) {
  return segment !== void 0 && /^[A-Za-z]:$/.test(segment);
}
function sessionFileAddress(sessionId, path) {
  const normalized = path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
  return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(normalized)}`;
}
function parseFileAddress(address) {
  try {
    if (!address.startsWith(FILE_ADDRESS_PREFIX)) return void 0;
    const end = address.search(/[?#]/);
    const [scope, ...rest] = address.slice(20, end === -1 ? void 0 : end).split("/");
    if (scope === "session") {
      const [id, ...segments] = rest;
      if (id === void 0 || id === "" || segments.length === 0) return void 0;
      return {
        scope,
        sessionId: decodeURIComponent(id),
        path: segments.map(decodeURIComponent).join("/")
      };
    }
    if (scope === "absolute") {
      const unc = rest[0] === "" && rest.length > 1;
      const segments = (unc ? rest.slice(1) : rest).map(decodeURIComponent);
      if (segments.length === 0 || segments[0] === "") return void 0;
      if (unc) return {
        scope,
        path: `//${segments.join("/")}`
      };
      return {
        scope,
        path: isDriveSegment(segments[0]) ? segments.join("/") : `/${segments.join("/")}`
      };
    }
    return;
  } catch {
    return;
  }
}
function isWindowsStylePath(value) {
  return /^[A-Za-z]:[/\\]/.test(value) || value.startsWith("\\\\");
}
function isAbsoluteWorkspacePath(path) {
  return path.startsWith("/") || isWindowsStylePath(path);
}
function resolveWorkspacePath(cwd, path) {
  if (isAbsoluteWorkspacePath(path)) return path;
  if (cwd === void 0 || cwd === "") return path;
  const separator = isWindowsStylePath(cwd) && cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[/\\]+$/, "")}${separator}${path.replace(/^[/\\]+/, "")}`;
}
function workspaceTitleOf(path) {
  const trimmed = path.replace(/[/\\]+$/, "");
  const separator = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(separator + 1);
}
function fileAddressFor(sessionId, cwd, path) {
  const normalized = path.replace(/\\/g, "/");
  if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized);
  const root = cwd === void 0 ? "" : cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root !== "" && normalized === root) return sessionFileAddress(sessionId, "");
  if (root !== "" && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
  return sessionFileAddress(sessionId, normalized);
}

// src/wire.ts
var ENTRY_PATH = "/api/mu-dsh-files.entry";
var DOWNLOAD_PATH = "/api/mu-dsh-files.download";
var WATCH_PATH = "/api/mu-dsh-files.watch";
var REFUSAL_HEADER = "X-Mu-Dsh-Refusal";

// src/client/api.ts
function routeUrl(base, route, path) {
  const url = new URL(route.slice(1), base);
  if (path !== void 0) url.searchParams.set("path", path);
  return url.href;
}
var CODES = /* @__PURE__ */ new Set(["bad-request", "not-found", "not-permitted", "not-regular", "too-large", "unavailable"]);
async function refusalOf(response) {
  try {
    const body = await response.json();
    if (typeof body.error === "string" && CODES.has(body.error) && typeof body.message === "string") return body;
  } catch {
  }
  let message = `HTTP ${response.status}`;
  const header = response.headers.get(REFUSAL_HEADER);
  if (header !== null) {
    try {
      message = decodeURIComponent(header);
    } catch {
    }
  }
  return { error: refusalForStatus(response.status), message };
}
function refusalForStatus(status) {
  switch (status) {
    case 400:
      return "bad-request";
    case 403:
      return "not-permitted";
    case 404:
      return "not-found";
    case 409:
      return "not-regular";
    case 413:
      return "too-large";
    default:
      return "unavailable";
  }
}
function failed(error) {
  return { ok: false, refusal: { error: "unavailable", message: error instanceof Error ? error.message : String(error) } };
}
var FilesApi = class {
  base;
  fetch;
  constructor(base, fetcher = (input, init) => globalThis.fetch(input, init)) {
    this.base = base;
    this.fetch = fetcher;
  }
  async entry(path, signal) {
    try {
      const response = await this.fetch(routeUrl(this.base(), ENTRY_PATH, path), { signal });
      if (!response.ok) return { ok: false, refusal: await refusalOf(response) };
      return { ok: true, value: await response.json() };
    } catch (error) {
      if (signal.aborted) throw error;
      return failed(error);
    }
  }
  downloadUrl(path) {
    return routeUrl(this.base(), DOWNLOAD_PATH, path);
  }
  /** Ask whether a download would be refused, without starting it. */
  async check(path, signal) {
    const url = this.downloadUrl(path);
    try {
      const response = await this.fetch(url, { method: "HEAD", signal });
      if (!response.ok) return { ok: false, refusal: await refusalOf(response) };
      return { ok: true, value: url };
    } catch (error) {
      if (signal.aborted) throw error;
      return failed(error);
    }
  }
  /**
   * Open a watch stream and read its events until it ends or `signal` aborts.
   * Rejects when the stream cannot be opened or breaks.
   */
  async *watchEvents(signal) {
    const response = await this.fetch(routeUrl(this.base(), WATCH_PATH), { signal, cache: "no-store" });
    if (!response.ok || response.body === null) {
      await response.body?.cancel();
      throw new Error(`the host refused a watch stream: HTTP ${response.status}`);
    }
    for await (const line of linesOf(chunksOf(response.body.pipeThrough(new TextDecoderStream())))) {
      if (line !== "") yield JSON.parse(line);
    }
  }
  /**
   * Change what a watch stream watches. `false` when the host no longer has
   * the stream; rejects when the host cannot be reached or refuses.
   */
  async watchControl(control) {
    const response = await this.fetch(routeUrl(this.base(), WATCH_PATH), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(control)
    });
    await response.body?.cancel();
    if (response.ok) return true;
    if (response.status === 404) return false;
    throw new Error(`the host refused to change a watch stream: HTTP ${response.status}`);
  }
};
async function* chunksOf(stream) {
  const reader = stream.getReader();
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.cancel().catch(() => {
    });
  }
}
async function* linesOf(chunks) {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let cut;
    while ((cut = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, cut);
      buffer = buffer.slice(cut + 1);
    }
  }
}
function saveUrl(url) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

// src/client/Download.tsx
var import_react = require("react");
var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");

// src/client/styles.ts
var PLUGIN = "mu-dsh-files";
var TAG = `${PLUGIN}/styles.css`;
var css = {
  root: "mdf-root",
  header: "mdf-header",
  path: "mdf-path",
  tool: "mdf-tool",
  body: "mdf-body",
  level: "mdf-level",
  item: "mdf-item",
  row: "mdf-row",
  rowMain: "mdf-row-main",
  rowTool: "mdf-row-tool",
  icon: "mdf-icon",
  name: "mdf-name",
  size: "mdf-size",
  other: "mdf-other",
  note: "mdf-note",
  status: "mdf-status",
  statusLine: "mdf-status-line",
  titleIcon: "mdf-title-icon",
  anchor: "mdf-anchor",
  bubble: "mdf-bubble",
  emptyAction: "mdf-empty-action"
};
var TEXT = `
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
`;
function addStyles() {
  if (typeof document === "undefined") return () => {
  };
  const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(TAG)}]`);
  if (existing !== null) return () => {
  };
  const tag = document.createElement("style");
  tag.dataset.plugin = PLUGIN;
  tag.dataset.pluginCss = TAG;
  tag.textContent = TEXT;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}

// src/client/Download.tsx
var import_jsx_runtime = require("react/jsx-runtime");
var REFUSAL_MS = 6e3;
function refusalText(t, refusal) {
  return refusal.error === "unavailable" ? t("error.unavailable", { message: refusal.message }) : t(`error.${refusal.error}`);
}
function refusalDetail(t, refusal) {
  const reason = refusalText(t, refusal);
  return refusal.error === "unavailable" || /^HTTP \d+$/.test(refusal.message) ? reason : `${reason} (${refusal.message})`;
}
function useDownload(api, path, t) {
  const [state, setState] = (0, import_react.useState)({ kind: "idle" });
  const pending = (0, import_react.useRef)(null);
  const timer = (0, import_react.useRef)(void 0);
  (0, import_react.useEffect)(() => () => {
    pending.current?.abort();
    clearTimeout(timer.current);
  }, []);
  const start = () => {
    pending.current?.abort();
    clearTimeout(timer.current);
    const controller = new AbortController();
    pending.current = controller;
    setState({ kind: "checking" });
    api.check(path, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        saveUrl(result.value);
        setState({ kind: "idle" });
        return;
      }
      setState({ kind: "refused", message: t("download.failed", { message: refusalDetail(t, result.refusal) }) });
      timer.current = setTimeout(() => {
        setState({ kind: "idle" });
      }, REFUSAL_MS);
    }, () => {
    });
  };
  return { state, start };
}
function Download({ api, path, archive, t, variant }) {
  const { state, start } = useDownload(api, path, t);
  const label = t(archive ? "download.zip" : "download");
  const icon = archive ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconArchiveOutlineRegular, {}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.IconDownloadOutlineRegular, {});
  const refused = state.kind === "refused" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: css.bubble, role: "status", children: state.message }) : null;
  if (variant === "button") {
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: css.anchor, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Button, { variant: "outline", size: "sm", icon, disabled: state.kind === "checking", onClick: start, "data-mu-dsh-download": path, children: label }),
      refused
    ] });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: variant === "row" ? `${css.anchor} ${css.rowTool}` : css.anchor, "data-state": state.kind === "idle" ? void 0 : state.kind, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_dsh_client_ui_primitives.Tooltip, { label, side: "bottom", delayMs: 500, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
      "button",
      {
        type: "button",
        className: css.tool,
        "aria-label": label,
        disabled: state.kind === "checking",
        "data-state": state.kind === "idle" ? void 0 : state.kind,
        "data-mu-dsh-download": path,
        onClick: (event) => {
          event.stopPropagation();
          start();
        },
        children: icon
      }
    ) }),
    refused
  ] });
}
function PreviewDownload({ absolutePath, api, t }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Download, { api, path: absolutePath, archive: false, t, variant: "tool" });
}
function UnpreviewableDownload({ absolutePath, api, t }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Download, { api, path: absolutePath, archive: false, t, variant: "button" });
}
function WorkspaceDownload({ absolutePath, api, t }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)(Download, { api, path: absolutePath, archive: true, t, variant: "tool" });
}

// src/client/Files.tsx
var import_react2 = require("react");
var import_dsh_client_ui_primitives2 = require("@deepseek-ai/dsh-client-ui-primitives");

// src/client/paths.ts
var FILE_ADDRESS_PATTERN = "dsh-resource://file/[\\s\\S]+";
function trimSlashes(path) {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}
function parentOf(path) {
  const trimmed = trimSlashes(path);
  if (trimmed === "/") return void 0;
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}
function childOf(parent, name) {
  return parent === "/" ? `/${name}` : `${parent}/${name}`;
}
function nameOf(path) {
  const trimmed = trimSlashes(path);
  return trimmed === "/" ? "/" : trimmed.slice(trimmed.lastIndexOf("/") + 1);
}
function sessionPathOf(address, cwdOf) {
  const parsed = parseFileAddress(address);
  if (parsed === void 0 || parsed.scope !== "session") return void 0;
  if (isAbsoluteWorkspacePath(parsed.path)) return { sessionId: parsed.sessionId, path: parsed.path, absolute: trimSlashes(parsed.path) };
  const cwd = cwdOf(parsed.sessionId);
  const absolute = cwd === void 0 || cwd === "" ? void 0 : trimSlashes(resolveWorkspacePath(cwd, parsed.path));
  return { sessionId: parsed.sessionId, path: parsed.path, absolute };
}
function titleOf(address, cwdOf) {
  const where = sessionPathOf(address, cwdOf);
  if (where === void 0) return address;
  const workspaceItself = where.path.replace(/\/+$/, "") === "" && !isAbsoluteWorkspacePath(where.path);
  if (!workspaceItself) return nameOf(where.path);
  const cwd = cwdOf(where.sessionId);
  return cwd === void 0 ? "/" : workspaceTitleOf(cwd) || cwd;
}
function sessionOf(contentId, tabSession) {
  const address = parseFileAddress(contentId);
  return address?.scope === "session" ? address.sessionId : tabSession;
}
function originOf(contentId, cwd) {
  const workspace = cwd === void 0 || cwd === "" ? void 0 : trimSlashes(cwd);
  if (parseFileAddress(contentId) === void 0) return { kind: "workspace", root: workspace };
  return { kind: "address", path: sessionPathOf(contentId, () => workspace)?.absolute, workspace };
}

// src/client/Files.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
function useModel(model) {
  return (0, import_react2.useSyncExternalStore)(model.subscribe, model.getSnapshot);
}
var byName = new Intl.Collator(void 0, { numeric: true, sensitivity: "base" });
function ordered(entries) {
  return [...entries].sort((left, right) => {
    const group = Number(right.type === "directory") - Number(left.type === "directory");
    return group !== 0 ? group : byName.compare(left.name, right.name);
  });
}
function FilesBody({ useTabInfo, useSessions, sessionId, t, face }) {
  const { tab, panel } = useTabInfo();
  const session = sessionOf(tab.contentId, sessionId);
  const cwd = useSessions((sessions) => sessions.byId[session]?.cwd);
  const model = face.models.get(tab.id, tab.signal);
  const snapshot = useModel(model);
  const latest = (0, import_react2.useRef)(tab);
  latest.current = tab;
  const navigator = (0, import_react2.useRef)(null);
  navigator.current ??= face.navigator(session, () => latest.current);
  const origin = originOf(tab.contentId, cwd);
  const path = origin.kind === "workspace" ? origin.root : origin.path;
  const workspace = origin.kind === "workspace" ? origin.root : origin.workspace;
  const { revision } = tab.navigation;
  const { phase } = snapshot;
  const root = phase.kind === "directory" ? phase.root : void 0;
  const scroller = (0, import_react2.useRef)(null);
  (0, import_react2.useEffect)(() => {
    void model.open(origin, navigator.current);
  }, [model, origin.kind, path, workspace, revision]);
  (0, import_react2.useEffect)(() => {
    model.setVisible(tab.visible);
    return () => {
      model.setVisible(false);
    };
  }, [model, tab.visible]);
  (0, import_react2.useEffect)(() => tab.actions.bindCommands({ refresh: () => {
    model.refresh();
  } }), [tab.actions, model]);
  (0, import_react2.useLayoutEffect)(() => {
    if (scroller.current !== null) scroller.current.scrollTop = model.scrollTop;
  }, [model, root]);
  if (phase.kind === "handed-off") return null;
  if (phase.kind === "probing") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Status, { line: t("opening") });
  if (phase.kind === "no-workspace") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Status, { line: t("noWorkspace") });
  if (phase.kind === "failed") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Status, { line: refusalText(t, phase.refusal) });
  if (phase.kind === "unviewable") {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Status, { line: t("unviewable"), children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Download, { api: face.api, path: phase.path, archive: false, t, variant: "button" }) });
  }
  const parent = parentOf(phase.root);
  const tree = {
    snapshot,
    t,
    api: face.api,
    onToggle: (path2) => {
      model.toggle(path2);
    },
    onOpen: (path2) => {
      face.openFile(session, cwd, path2, panel.id);
    }
  };
  const reload = t(snapshot.stale ? "reload.stale" : "reload");
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: css.root, "data-mu-dsh-files": phase.root, "data-mu-dsh-origin": origin.kind, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: css.header, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.PathLabel, { path: phase.root, className: css.path }),
      parent !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Tooltip, { label: t("up"), side: "bottom", delayMs: 500, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          className: css.tool,
          "aria-label": t("up"),
          "data-mu-dsh-up": true,
          onClick: () => {
            face.openFolder(tab, session, cwd, parent);
          },
          children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconChevronUpOutlineRegular, {})
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Tooltip, { label: reload, shortcutKeys: tab.refreshShortcut?.keys, side: "bottom", delayMs: 500, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          className: css.tool,
          "aria-label": reload,
          "aria-keyshortcuts": tab.refreshShortcut?.aria,
          "data-mu-dsh-reload": true,
          "data-state": snapshot.stale ? "stale" : void 0,
          onClick: () => {
            model.refresh();
          },
          children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconRefreshOutlineRegular, {})
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Download, { api: face.api, path: phase.root, archive: true, t, variant: "tool" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { ref: scroller, className: css.body, onScroll: (event) => {
      model.scrollTop = event.currentTarget.scrollTop;
    }, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: css.level, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Level, { path: phase.root, tree }) }) })
  ] });
}
function Status({ line, children }) {
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: css.status, "data-mu-dsh-status": true, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: css.statusLine, children: line }),
    children
  ] });
}
function Level({ path, tree }) {
  const { snapshot, t } = tree;
  const level = snapshot.levels[path];
  if (level === void 0 || level.kind === "loading") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { className: css.note, children: t("loading") });
  if (level.kind === "failed") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { className: css.note, "data-mu-dsh-failed": level.refusal.error, children: refusalText(t, level.refusal) });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    level.failure !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { className: css.note, "data-mu-dsh-failed": level.failure.error, children: refusalText(t, level.failure) }),
    level.entries.length === 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { className: css.note, children: t("empty") }),
    ordered(level.entries).map((entry) => /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Entry, { parent: path, entry, tree }, entry.name)),
    level.truncated && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { className: css.note, children: t("truncated") })
  ] });
}
function Entry({ parent, entry, tree }) {
  const path = childOf(parent, entry.name);
  const { t, api } = tree;
  if (entry.type === "directory") {
    const expanded = tree.snapshot.expanded.includes(path);
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("li", { className: css.item, "data-mu-dsh-entry": "directory", "data-mu-dsh-path": path, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: css.row, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", className: css.rowMain, "aria-expanded": expanded, onClick: () => {
          tree.onToggle(path);
        }, children: [
          expanded ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconFolderOpenRegular, { className: css.icon }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconFolderCloseRegular, { className: css.icon }),
          /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: css.name, children: entry.name })
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Download, { api, path, archive: true, t, variant: "row" })
      ] }),
      expanded && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: css.level, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Level, { path, tree }) })
    ] });
  }
  if (entry.type === "file") {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { className: css.item, "data-mu-dsh-entry": "file", "data-mu-dsh-path": path, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: css.row, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("button", { type: "button", className: css.rowMain, onClick: () => {
        tree.onOpen(path);
      }, children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.FileTypeIcon, { kind: (0, import_dsh_client_ui_primitives2.classifyFileType)(entry.name), size: 16, className: css.icon }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: css.name, children: entry.name }),
        entry.size !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: css.size, children: (0, import_dsh_client_ui_primitives2.fileSizeText)(entry.size) })
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Download, { api, path, archive: false, t, variant: "row" })
    ] }) });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("li", { className: css.item, "data-mu-dsh-entry": "other", "data-mu-dsh-path": path, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: css.row, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: `${css.rowMain} ${css.other}`, "aria-disabled": "true", title: t("entry.other"), children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: css.name, children: entry.name }) }) }) });
}
function FilesTitle({ useTabInfo, face }) {
  const { tab } = useTabInfo();
  const snapshot = useModel(face.models.get(tab.id, tab.signal));
  const folder = parseFileAddress(tab.contentId) === void 0 || snapshot.phase.kind === "directory";
  const icon = folder ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.FileTypeIcon, { kind: "folder", size: 16, className: css.titleIcon }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.FileTypeIcon, { path: tab.title, size: 16, className: css.titleIcon });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    icon,
    tab.title
  ] });
}

// src/client/locales.ts
var NS = "mu-dsh-files";
var en = {
  "type.label": "Files",
  "guide.title": "Workspace files",
  "guide.description": "Browse this session's workspace, and download files and folders",
  opening: "Opening\u2026",
  loading: "Reading\u2026",
  empty: "Empty folder",
  truncated: "This folder holds too many entries; only the first are shown.",
  "entry.other": "Neither a file nor a folder; it cannot be opened.",
  noWorkspace: "This session has no workspace folder.",
  reload: "Reload",
  "reload.stale": "Reload. Changes on disk are not showing up by themselves right now.",
  up: "Open the enclosing folder",
  download: "Download",
  "download.zip": "Download as ZIP",
  "download.failed": "Download refused: {message}",
  unviewable: "Nothing in this workspace can show this file.",
  "error.not-found": "This no longer exists; it may have been moved or deleted.",
  "error.not-permitted": "dsh may not read this.",
  "error.not-regular": "This is neither a file nor a folder.",
  "error.too-large": "Too large to download as one archive.",
  "error.bad-request": "This path cannot be read.",
  "error.unavailable": "Could not read this: {message}"
};
var zh = {
  "type.label": "\u6587\u4EF6",
  "guide.title": "\u5DE5\u4F5C\u533A\u6587\u4EF6",
  "guide.description": "\u6D4F\u89C8\u4F1A\u8BDD\u7684\u5DE5\u4F5C\u533A\uFF0C\u4E0B\u8F7D\u6587\u4EF6\u548C\u6587\u4EF6\u5939",
  opening: "\u6B63\u5728\u6253\u5F00\u2026",
  loading: "\u6B63\u5728\u8BFB\u53D6\u2026",
  empty: "\u7A7A\u6587\u4EF6\u5939",
  truncated: "\u6761\u76EE\u592A\u591A\uFF0C\u53EA\u663E\u793A\u4E86\u524D\u9762\u4E00\u90E8\u5206\u3002",
  "entry.other": "\u8FD9\u4E0D\u662F\u6587\u4EF6\u6216\u6587\u4EF6\u5939\uFF0C\u6CA1\u6CD5\u6253\u5F00\u3002",
  noWorkspace: "\u8FD9\u4E2A\u4F1A\u8BDD\u6CA1\u6709\u5DE5\u4F5C\u533A\u6587\u4EF6\u5939\u3002",
  reload: "\u91CD\u65B0\u8BFB\u53D6",
  "reload.stale": "\u91CD\u65B0\u8BFB\u53D6\u3002\u78C1\u76D8\u4E0A\u7684\u6539\u52A8\u6682\u65F6\u4E0D\u4F1A\u81EA\u52A8\u663E\u793A\u3002",
  up: "\u6253\u5F00\u4E0A\u4E00\u7EA7\u6587\u4EF6\u5939",
  download: "\u4E0B\u8F7D",
  "download.zip": "\u4E0B\u8F7D\u4E3A ZIP",
  "download.failed": "\u65E0\u6CD5\u4E0B\u8F7D\uFF1A{message}",
  unviewable: "\u6CA1\u6709\u53EF\u4EE5\u663E\u793A\u8FD9\u4E2A\u6587\u4EF6\u7684\u67E5\u770B\u5668\u3002",
  "error.not-found": "\u5B83\u5DF2\u7ECF\u4E0D\u5728\u4E86\uFF0C\u53EF\u80FD\u88AB\u79FB\u52A8\u6216\u5220\u9664\u3002",
  "error.not-permitted": "dsh \u65E0\u6743\u8BFB\u53D6\u5B83\u3002",
  "error.not-regular": "\u8FD9\u4E0D\u662F\u6587\u4EF6\u6216\u6587\u4EF6\u5939\u3002",
  "error.too-large": "\u592A\u5927\u4E86\uFF0C\u65E0\u6CD5\u6253\u5305\u6210\u4E00\u4E2A\u538B\u7F29\u5305\u4E0B\u8F7D\u3002",
  "error.bad-request": "\u65E0\u6CD5\u8BFB\u53D6\u8FD9\u4E2A\u8DEF\u5F84\u3002",
  "error.unavailable": "\u8BFB\u53D6\u5931\u8D25\uFF1A{message}"
};

// src/client/tree.ts
var INITIAL = { phase: { kind: "probing" }, levels: {}, expanded: [], stale: false };
var TreeModel = class {
  snapshot = INITIAL;
  listeners = /* @__PURE__ */ new Set();
  signal;
  deps;
  /** Bumped whenever the tree is reset, so that nothing begun for the old one settles the new one. */
  epoch = 0;
  /** Listings running, by path; `again` asks for one more after the current. */
  reading = /* @__PURE__ */ new Map();
  watches = /* @__PURE__ */ new Map();
  /** Watched paths whose watch is lost for now. */
  lost = /* @__PURE__ */ new Set();
  visible = false;
  /** Where the reader left the tree scrolled, for when the body is drawn again. */
  scrollTop = 0;
  /** @param signal - the tab's lifetime; nothing settles, and nothing is watched, after it aborts. */
  constructor(signal, deps) {
    this.signal = signal;
    this.deps = deps;
    signal.addEventListener("abort", () => {
      this.follow();
    }, { once: true });
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /**
   * The tab was navigated to (opened, or opened again): find out what it
   * shows, or, for the directory already shown, list it again.
   */
  async open(origin, navigator) {
    const path = origin.kind === "workspace" ? origin.root : origin.path;
    const { phase } = this.snapshot;
    if (phase.kind === "directory" && path !== void 0 && trimSlashes(path) === phase.root) {
      this.refresh();
      return;
    }
    const epoch = this.reset({ kind: "probing" });
    if (origin.kind === "workspace" && origin.root === void 0) {
      this.set({ phase: { kind: "no-workspace" } });
      return;
    }
    if (path === void 0) {
      this.giveAway(navigator, void 0);
      return;
    }
    const result = await this.read(path);
    if (result === void 0 || epoch !== this.epoch) return;
    if (result.ok && result.value.type === "directory") {
      const root = trimSlashes(result.value.path);
      if (origin.kind === "address" && origin.workspace !== void 0 && root === trimSlashes(origin.workspace)) {
        this.set({ phase: { kind: "handed-off" } });
        navigator.toWorkspace();
        return;
      }
      this.set({ phase: { kind: "directory", root }, levels: { [root]: levelOf(result.value) } });
      return;
    }
    if (origin.kind === "workspace") {
      const refusal = result.ok ? { error: "not-regular", message: `${path} is not a directory` } : result.refusal;
      this.set({ phase: { kind: "failed", refusal } });
      return;
    }
    this.giveAway(navigator, result);
  }
  /** Open a directory row (listing it) or close it. */
  toggle(path) {
    const { expanded } = this.snapshot;
    if (expanded.includes(path)) {
      this.set({ expanded: expanded.filter((p) => p !== path) });
      return;
    }
    this.set({ expanded: [...expanded, path] });
    this.list(path);
  }
  /** List every directory shown open again, keeping what is shown until each answers. */
  refresh() {
    for (const path of this.shown()) this.list(path);
  }
  /** Follow the disk while the tab can be seen; a tab seen again is listed again as its watches stand. */
  setVisible(visible) {
    if (this.visible === visible) return;
    this.visible = visible;
    this.set({});
  }
  /** Change the snapshot, then watch what it shows. */
  set(next) {
    if (this.signal.aborted) return;
    this.snapshot = { ...this.snapshot, ...next };
    this.follow();
    const stale = this.lost.size > 0;
    if (stale !== this.snapshot.stale) this.snapshot = { ...this.snapshot, stale };
    for (const listener of this.listeners) listener();
  }
  setLevel(path, level) {
    this.set({ levels: { ...this.snapshot.levels, [path]: level } });
  }
  reset(phase) {
    this.epoch += 1;
    this.reading = /* @__PURE__ */ new Map();
    this.scrollTop = 0;
    this.set({ phase, levels: {}, expanded: [] });
    return this.epoch;
  }
  giveAway(navigator, probed) {
    if (navigator.handOff()) {
      this.set({ phase: { kind: "handed-off" } });
    } else if (probed === void 0) {
      this.set({ phase: { kind: "failed", refusal: { error: "bad-request", message: "the workspace of this path is unknown" } } });
    } else if (probed.ok) {
      this.set({ phase: { kind: "unviewable", path: probed.value.path } });
    } else {
      this.set({ phase: { kind: "failed", refusal: probed.refusal } });
    }
  }
  /** The host's answer for a path; `undefined` once the tab has ended. */
  async read(path) {
    try {
      return await this.deps.entry(path, this.signal);
    } catch (error) {
      if (this.signal.aborted) return void 0;
      throw error;
    }
  }
  list(path) {
    const running = this.reading.get(path);
    if (running !== void 0) {
      running.again = true;
      return;
    }
    void this.listing(path);
  }
  async listing(path) {
    const epoch = this.epoch;
    const run = { again: false };
    const reading = this.reading;
    reading.set(path, run);
    if (this.snapshot.levels[path] === void 0) this.setLevel(path, { kind: "loading" });
    try {
      do {
        run.again = false;
        const result = await this.read(path);
        if (result === void 0 || epoch !== this.epoch) return;
        this.setLevel(path, this.settled(path, result));
      } while (run.again);
    } finally {
      if (reading.get(path) === run) reading.delete(path);
    }
  }
  settled(path, result) {
    if (result.ok) {
      if (result.value.type === "directory") return levelOf(result.value);
      return { kind: "failed", refusal: { error: "not-regular", message: `${path} is no longer a directory` } };
    }
    const shown = this.snapshot.levels[path];
    if (shown?.kind === "ready" && result.refusal.error === "unavailable") {
      return { kind: "ready", entries: shown.entries, truncated: shown.truncated, failure: result.refusal };
    }
    return { kind: "failed", refusal: result.refusal };
  }
  /** The directories shown open: the root, and each opened directory every ancestor of which is open and listed. */
  shown() {
    const { phase, levels, expanded } = this.snapshot;
    if (phase.kind !== "directory") return [];
    const open = new Set(expanded);
    const shown = [];
    const visit = (path) => {
      shown.push(path);
      const level = levels[path];
      if (level?.kind !== "ready") return;
      for (const entry of level.entries) {
        const child = childOf(path, entry.name);
        if (entry.type === "directory" && open.has(child)) visit(child);
      }
    };
    visit(phase.root);
    return shown;
  }
  /** Watch exactly the directories shown open, while the tab is visible and alive. */
  follow() {
    const wanted = new Set(this.visible && !this.signal.aborted ? this.shown() : []);
    for (const [path, stop] of this.watches) {
      if (wanted.has(path)) continue;
      stop();
      this.watches.delete(path);
      this.lost.delete(path);
    }
    for (const path of wanted) {
      if (!this.watches.has(path)) this.watches.set(path, this.deps.watcher.watch(path, (signal) => {
        this.heard(path, signal);
      }));
    }
  }
  heard(path, signal) {
    if (!this.watches.has(path)) return;
    const wasLost = this.lost.has(path);
    if (signal === "lost") this.lost.add(path);
    else if (signal === "ready") this.lost.delete(path);
    if (this.lost.has(path) !== wasLost) this.set({});
    if (signal !== "lost") this.list(path);
  }
};
function levelOf(directory) {
  return { kind: "ready", entries: directory.entries, truncated: directory.truncated };
}
var TreeModels = class {
  byTab = /* @__PURE__ */ new Map();
  deps;
  constructor(deps) {
    this.deps = deps;
  }
  get(tabId, signal) {
    let model = this.byTab.get(tabId);
    if (signal.aborted) return model ?? new TreeModel(signal, this.deps);
    if (model === void 0) {
      model = new TreeModel(signal, this.deps);
      this.byTab.set(tabId, model);
      signal.addEventListener("abort", () => {
        this.byTab.delete(tabId);
      }, { once: true });
    }
    return model;
  }
};

// src/client/watch.ts
var HUB_OPTIONS = {
  reconnectMs: 1e3,
  reconnectMaxMs: 3e4,
  lingerMs: 15e3,
  openTimeoutMs: 3e4,
  missedHeartbeats: 3
};
var WatchHub = class {
  transport;
  options;
  paths = /* @__PURE__ */ new Map();
  connection;
  running = false;
  disposed = false;
  /** What to ask of the current stream next. */
  adds = /* @__PURE__ */ new Set();
  removes = /* @__PURE__ */ new Set();
  sending = false;
  linger;
  wake;
  constructor(transport, options = HUB_OPTIONS) {
    this.transport = transport;
    this.options = options;
  }
  watch(path, listener) {
    if (this.disposed) return () => {
    };
    let watched = this.paths.get(path);
    if (watched === void 0) {
      watched = { listeners: /* @__PURE__ */ new Set(), ready: false };
      this.paths.set(path, watched);
      this.want(path, true);
    } else if (watched.ready) {
      const known = watched;
      queueMicrotask(() => {
        if (known.ready && known.listeners.has(listener)) listener("ready");
      });
    }
    const entry = watched;
    entry.listeners.add(listener);
    clearTimeout(this.linger);
    this.linger = void 0;
    this.run();
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      entry.listeners.delete(listener);
      if (entry.listeners.size > 0 || this.paths.get(path) !== entry) return;
      this.paths.delete(path);
      this.want(path, false);
      if (this.paths.size === 0) {
        this.linger = setTimeout(() => {
          if (this.paths.size === 0) this.connection?.lifetime.abort();
        }, this.options.lingerMs);
      }
    };
  }
  /** Stop everything: the plugin is going away. */
  dispose() {
    this.disposed = true;
    this.paths.clear();
    clearTimeout(this.linger);
    this.connection?.lifetime.abort();
    this.wake?.();
  }
  want(path, add) {
    if (add) {
      this.removes.delete(path);
      this.adds.add(path);
    } else if (!this.adds.delete(path)) {
      this.removes.add(path);
    }
    void this.send();
  }
  /** Send what changed, one request at a time, for as long as there is something to send and a stream to send it to. */
  async send() {
    if (this.sending) return;
    this.sending = true;
    try {
      await Promise.resolve();
      for (; ; ) {
        const connection = this.connection;
        const stream = connection?.stream;
        if (connection === void 0 || stream === void 0 || this.adds.size === 0 && this.removes.size === 0) return;
        const control = { stream, add: [...this.adds], remove: [...this.removes] };
        this.adds.clear();
        this.removes.clear();
        let known;
        try {
          known = await this.transport.control(control);
        } catch {
          known = false;
        }
        if (!known) {
          connection.lifetime.abort();
          return;
        }
      }
    } finally {
      this.sending = false;
    }
  }
  run() {
    if (this.running || this.disposed || this.paths.size === 0) return;
    this.running = true;
    void this.connect().finally(() => {
      this.running = false;
      this.run();
    });
  }
  async connect() {
    let failures = 0;
    while (!this.disposed && this.paths.size > 0) {
      const connection = { lifetime: new AbortController() };
      this.connection = connection;
      let opened = false;
      try {
        await this.follow(connection, () => {
          opened = true;
        });
      } catch {
      }
      connection.lifetime.abort();
      this.connection = void 0;
      this.adds.clear();
      this.removes.clear();
      this.lose();
      if (this.disposed || this.paths.size === 0) return;
      failures = opened ? 0 : failures + 1;
      await this.pause(Math.min(this.options.reconnectMaxMs, this.options.reconnectMs * 2 ** Math.max(0, failures - 1)));
    }
  }
  /** Read one stream until it ends, hearing something at least every few heartbeats. */
  async follow(connection, opened) {
    const { lifetime } = connection;
    let silence;
    const expect = (ms) => {
      clearTimeout(silence);
      silence = setTimeout(() => {
        lifetime.abort();
      }, ms);
    };
    expect(this.options.openTimeoutMs);
    let patience = this.options.openTimeoutMs;
    try {
      for await (const event of this.transport.events(lifetime.signal)) {
        if (event.type === "open") {
          connection.stream = event.stream;
          patience = event.heartbeatMs * this.options.missedHeartbeats;
          opened();
          this.removes.clear();
          for (const path of this.paths.keys()) this.adds.add(path);
          void this.send();
        } else if (event.type !== "ping") {
          this.dispatch(event.path, event.type);
        }
        expect(patience);
      }
    } finally {
      clearTimeout(silence);
    }
  }
  dispatch(path, signal) {
    const watched = this.paths.get(path);
    if (watched === void 0) return;
    if (signal === "ready") watched.ready = true;
    else if (signal === "lost") watched.ready = false;
    for (const listener of [...watched.listeners]) listener(signal);
  }
  /** The stream ended: nothing is watched until a new one says otherwise. */
  lose() {
    for (const path of [...this.paths.keys()]) this.dispatch(path, "lost");
  }
  pause(ms) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wake = void 0;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }
};

// src/client/index.ts
var FILES_ID = "mu-dsh-files";
var FILES_KIND = "files";
var FILES_COMMAND = "workspace.files";
var SERVICES = ["slots", "locale", "sidebarRightTabs", "sidebarRight", "sessions"];
function apply(ctx) {
  ctx.inject(SERVICES, (ctx2) => {
    try {
      install(ctx2);
    } catch (error) {
      console.error("mu-dsh-files: not available in this dsh:", error);
      throw error;
    }
  });
}
function install(ctx) {
  ctx.effect(() => addStyles(), "mu-dsh-files: styles");
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), "mu-dsh-files: dictionaries");
  const t = ctx.locale.bind(NS);
  const api = new FilesApi(() => document.baseURI);
  const watcher = new WatchHub({ events: (signal) => api.watchEvents(signal), control: (control) => api.watchControl(control) });
  ctx.effect(() => () => {
    watcher.dispose();
  }, "mu-dsh-files: watches");
  const models = new TreeModels({ entry: (path, signal) => api.entry(path, signal), watcher });
  const cwdOf = (sessionId) => ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
  const definition = {
    id: FILES_ID,
    kind: FILES_KIND,
    patterns: [FILE_ADDRESS_PATTERN],
    priority: "extension",
    // The file preview, which this hands files to, opens Session addresses only.
    canOpen: (address) => parseFileAddress(address)?.scope === "session",
    // Opened by kind, the tab has a page address, which is no file address.
    title: (address) => parseFileAddress(address) === void 0 ? t("type.label") : titleOf(address, cwdOf),
    guide: [{
      // dsh's own entry id, so that a choice to pin or unpin it carries over.
      id: "workspace",
      commandId: FILES_COMMAND,
      order: 10,
      title: () => t("guide.title"),
      description: () => t("guide.description"),
      icon: import_dsh_client_ui_primitives3.GuideArtworkFiles
    }]
  };
  const nextKind = (address) => ctx.sidebarRightTabs.candidates(address).find((candidate) => candidate.id !== FILES_ID)?.kind;
  const open = (sessionId, address, options) => {
    const kind = nextKind(address);
    if (kind === void 0) return false;
    ctx.sidebarRight.openResourceIn(sessionId, address, { ...options, kind });
    return true;
  };
  const face = {
    models,
    api,
    navigator: (sessionId, tab) => ({
      handOff: () => {
        const current = tab();
        if (current.signal.aborted) return true;
        const params = current.navigation.params;
        return open(sessionId, current.contentId, { replaceTab: current.id, params });
      },
      toWorkspace: () => {
        const current = tab();
        if (!current.signal.aborted) current.actions.openTab(FILES_KIND, { replaceTab: true });
      }
    }),
    openFile: (sessionId, cwd, path, paneId) => {
      const address = fileAddressFor(sessionId, cwd, path);
      const placement = { paneId };
      if (!open(sessionId, address, placement)) ctx.sidebarRight.openResourceIn(sessionId, address, { ...placement, kind: FILES_KIND });
    },
    openFolder: (tab, sessionId, cwd, path) => {
      if (cwd !== void 0 && cwd !== "" && trimSlashes(path) === trimSlashes(cwd)) {
        tab.actions.openTab(FILES_KIND, { replaceTab: true });
      } else {
        tab.actions.openResource(fileAddressFor(sessionId, cwd, path), { replaceTab: true });
      }
    }
  };
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => contained("the Files tab", () => {
    const body = ctx.slots.register({
      name: "sidebar.right.pane.tab",
      key: FILES_ID,
      locale: NS,
      inject: () => ({ face })
    }, FilesBody);
    try {
      const type = ctx.sidebarRightTabs.register(definition);
      return () => {
        type();
        body();
      };
    } catch (error) {
      body();
      throw error;
    }
  })), "mu-dsh-files: Files type and body");
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => contained("the Files tab title", () => ctx.slots.register({
    name: "sidebar.right.pane.tab.title",
    key: FILES_ID,
    inject: () => ({ face })
  }, FilesTitle))), "mu-dsh-files: Files title");
  ctx.effect(() => ctx.slots.inject("sidebar.right.tab.document.actions", () => contained("the preview download", () => ctx.slots.register({
    name: "sidebar.right.tab.document.actions",
    id: "mu-dsh-files",
    locale: NS,
    inject: () => ({ api })
  }, PreviewDownload))), "mu-dsh-files: preview download");
  ctx.effect(() => ctx.slots.inject("sidebar.right.tab.document.unpreviewable", () => contained("the unpreviewable download", () => ctx.slots.register({
    name: "sidebar.right.tab.document.unpreviewable",
    id: "mu-dsh-files",
    locale: NS,
    inject: () => ({ api })
  }, UnpreviewableDownload))), "mu-dsh-files: unpreviewable download");
  ctx.effect(() => ctx.slots.inject("sidebar.right.tab.files.actions", () => contained("the workspace download", () => ctx.slots.register({
    name: "sidebar.right.tab.files.actions",
    id: "mu-dsh-files",
    locale: NS,
    inject: () => ({ api })
  }, WorkspaceDownload))), "mu-dsh-files: workspace download");
}
function contained(what, register) {
  try {
    return register();
  } catch (error) {
    console.error(`mu-dsh-files: ${what} is not available:`, error);
    return () => {
    };
  }
}

		return module.exports;
	}
});
