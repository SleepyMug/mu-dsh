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
  FOLDER_ID: () => FOLDER_ID,
  FOLDER_KIND: () => FOLDER_KIND,
  apply: () => apply
});
module.exports = __toCommonJS(index_exports);

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
var REFUSAL_HEADER = "X-Mu-Dsh-Refusal";

// src/client/api.ts
function routeUrl(base, route, path) {
  const url = new URL(route.slice(1), base);
  url.searchParams.set("path", path);
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
};
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

// src/client/Folder.tsx
var import_react2 = require("react");
var import_dsh_client_ui_primitives2 = require("@deepseek-ai/dsh-client-ui-primitives");

// src/client/paths.ts
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

// src/client/Folder.tsx
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
function FolderBody({ useTabInfo, useSessions, sessionId, t, face }) {
  const { tab, panel } = useTabInfo();
  const cwd = useSessions((sessions) => sessions.byId[sessionId]?.cwd);
  const model = face.models.get(tab.id, tab.signal);
  const snapshot = useModel(model);
  const latest = (0, import_react2.useRef)(tab);
  latest.current = tab;
  const host = (0, import_react2.useRef)(null);
  host.current ??= face.host(sessionId, () => latest.current);
  const absolute = sessionPathOf(tab.contentId, () => cwd)?.absolute;
  const { revision } = tab.navigation;
  (0, import_react2.useEffect)(() => {
    void model.open(absolute, host.current);
  }, [model, absolute, revision]);
  (0, import_react2.useEffect)(() => tab.actions.bindCommands({ refresh: () => {
    void model.refresh(host.current);
  } }), [tab.actions, model]);
  const { phase } = snapshot;
  if (phase.kind === "handed-off") return null;
  if (phase.kind === "probing") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Status, { line: t("opening") });
  if (phase.kind === "failed") return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Status, { line: refusalText(t, phase.refusal) });
  if (phase.kind === "unviewable") {
    return /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Status, { line: t("unviewable"), children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Download, { api: face.api, path: phase.path, archive: false, t, variant: "button" }) });
  }
  const { root } = phase;
  const parent = parentOf(root);
  const tree = {
    snapshot,
    t,
    api: face.api,
    onToggle: (path) => {
      void model.toggle(path, host.current);
    },
    onOpen: (path) => {
      face.openFile(sessionId, cwd, path, panel.id);
    }
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: css.root, "data-mu-dsh-folder": root, children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: css.header, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.PathLabel, { path: root, className: css.path }),
      parent !== void 0 && /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Tooltip, { label: t("up"), side: "bottom", delayMs: 500, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          className: css.tool,
          "aria-label": t("up"),
          "data-mu-dsh-up": true,
          onClick: () => {
            face.openFolder(tab, sessionId, cwd, parent);
          },
          children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconChevronUpOutlineRegular, {})
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.Tooltip, { label: t("reload"), shortcutKeys: tab.refreshShortcut?.keys, side: "bottom", delayMs: 500, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "button",
        {
          type: "button",
          className: css.tool,
          "aria-label": t("reload"),
          "aria-keyshortcuts": tab.refreshShortcut?.aria,
          "data-mu-dsh-reload": true,
          onClick: () => {
            void model.refresh(host.current);
          },
          children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.IconRefreshOutlineRegular, {})
        }
      ) }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Download, { api: face.api, path: root, archive: true, t, variant: "tool" })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("div", { className: css.body, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("ul", { className: css.level, children: /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(Level, { path: root, tree }) }) })
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
function FolderTitle({ useTabInfo, face }) {
  const { tab } = useTabInfo();
  const snapshot = useModel(face.models.get(tab.id, tab.signal));
  const icon = snapshot.phase.kind === "directory" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.FileTypeIcon, { kind: "folder", size: 16, className: css.titleIcon }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(import_dsh_client_ui_primitives2.FileTypeIcon, { path: tab.title, size: 16, className: css.titleIcon });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(import_jsx_runtime2.Fragment, { children: [
    icon,
    tab.title
  ] });
}

// src/client/folder.ts
var INITIAL = { phase: { kind: "probing" }, levels: {}, expanded: [] };
var FolderModel = class {
  snapshot = INITIAL;
  listeners = /* @__PURE__ */ new Set();
  generations = /* @__PURE__ */ new Map();
  probeGeneration = 0;
  signal;
  /** @param signal - the tab's lifetime; nothing settles after it aborts. */
  constructor(signal) {
    this.signal = signal;
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  set(next) {
    if (this.signal.aborted) return;
    this.snapshot = { ...this.snapshot, ...next };
    for (const listener of this.listeners) listener();
  }
  setLevel(path, level) {
    this.set({ levels: { ...this.snapshot.levels, [path]: level } });
  }
  /**
   * The tab was navigated to (opened, or its address opened again): find out
   * what the path is, or, for a directory already shown, list it again.
   * @param absolute - the address's absolute path; `undefined` when it cannot be known here.
   */
  async open(absolute, host) {
    const { phase } = this.snapshot;
    if (phase.kind === "directory" && absolute !== void 0 && trimSlashes(absolute) === phase.root) {
      await this.refresh(host);
      return;
    }
    const generation = ++this.probeGeneration;
    this.set({ phase: { kind: "probing" }, levels: {}, expanded: [] });
    if (absolute === void 0) {
      this.giveAway(host, void 0);
      return;
    }
    const result = await host.entry(absolute, this.signal);
    if (this.signal.aborted || generation !== this.probeGeneration) return;
    if (result.ok && result.value.type === "directory") {
      const root = trimSlashes(result.value.path);
      this.generations.set(root, (this.generations.get(root) ?? 0) + 1);
      this.set({
        phase: { kind: "directory", root },
        levels: { [root]: { kind: "ready", entries: result.value.entries, truncated: result.value.truncated } }
      });
      return;
    }
    this.giveAway(host, result);
  }
  giveAway(host, probed) {
    if (host.handOff()) {
      this.set({ phase: { kind: "handed-off" } });
    } else if (probed === void 0) {
      this.set({ phase: { kind: "failed", refusal: { error: "bad-request", message: "the workspace of this path is unknown" } } });
    } else if (probed.ok) {
      this.set({ phase: { kind: "unviewable", path: probed.value.path } });
    } else {
      this.set({ phase: { kind: "failed", refusal: probed.refusal } });
    }
  }
  /** Expand a directory row (listing it) or collapse it. */
  async toggle(path, host) {
    const { expanded } = this.snapshot;
    if (expanded.includes(path)) {
      this.set({ expanded: expanded.filter((p) => p !== path) });
      return;
    }
    this.set({ expanded: [...expanded, path] });
    await this.list(path, host);
  }
  /** List the root and every expanded directory again, keeping what is shown until each answers. */
  async refresh(host) {
    const { phase, expanded } = this.snapshot;
    if (phase.kind !== "directory") return;
    await Promise.all([phase.root, ...expanded].map((path) => this.list(path, host)));
  }
  async list(path, host) {
    const generation = (this.generations.get(path) ?? 0) + 1;
    this.generations.set(path, generation);
    const shown = this.snapshot.levels[path];
    this.setLevel(path, shown?.kind === "ready" ? { ...shown, refreshing: true } : { kind: "loading" });
    const result = await host.entry(path, this.signal);
    if (this.signal.aborted || this.generations.get(path) !== generation) return;
    if (!result.ok) {
      this.setLevel(path, { kind: "failed", refusal: result.refusal });
    } else if (result.value.type !== "directory") {
      this.setLevel(path, { kind: "failed", refusal: { error: "not-regular", message: `${path} is no longer a directory` } });
    } else {
      this.setLevel(path, { kind: "ready", entries: result.value.entries, truncated: result.value.truncated });
    }
  }
};
var FolderModels = class {
  byTab = /* @__PURE__ */ new Map();
  get(tabId, signal) {
    let model = this.byTab.get(tabId);
    if (signal.aborted) return model ?? new FolderModel(signal);
    if (model === void 0) {
      model = new FolderModel(signal);
      this.byTab.set(tabId, model);
      signal.addEventListener("abort", () => {
        this.byTab.delete(tabId);
      }, { once: true });
    }
    return model;
  }
  peek(tabId) {
    return this.byTab.get(tabId);
  }
};

// src/client/locales.ts
var NS = "mu-dsh-files";
var en = {
  "type.label": "Folder",
  opening: "Opening\u2026",
  loading: "Reading\u2026",
  empty: "Empty folder",
  truncated: "This folder holds too many entries; only the first are shown.",
  "entry.other": "Neither a file nor a folder; it cannot be opened.",
  reload: "Reload",
  up: "Open the enclosing folder",
  open: "Open",
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
  "type.label": "\u6587\u4EF6\u5939",
  opening: "\u6B63\u5728\u6253\u5F00\u2026",
  loading: "\u6B63\u5728\u8BFB\u53D6\u2026",
  empty: "\u7A7A\u6587\u4EF6\u5939",
  truncated: "\u6761\u76EE\u592A\u591A\uFF0C\u53EA\u663E\u793A\u4E86\u524D\u9762\u4E00\u90E8\u5206\u3002",
  "entry.other": "\u8FD9\u4E0D\u662F\u6587\u4EF6\u6216\u6587\u4EF6\u5939\uFF0C\u6CA1\u6CD5\u6253\u5F00\u3002",
  reload: "\u91CD\u65B0\u8BFB\u53D6",
  up: "\u6253\u5F00\u4E0A\u4E00\u7EA7\u6587\u4EF6\u5939",
  open: "\u6253\u5F00",
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

// src/client/index.ts
var FOLDER_ID = "mu-dsh-files/folder";
var FOLDER_KIND = "mu-dsh-files.folder";
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
  const api = new FilesApi(() => document.baseURI);
  const models = new FolderModels();
  const cwdOf = (sessionId) => ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
  const definition = {
    id: FOLDER_ID,
    kind: FOLDER_KIND,
    patterns: ["dsh-resource://file/**"],
    priority: "extension",
    // The file preview, which this hands files to, opens Session addresses only.
    canOpen: (address) => parseFileAddress(address)?.scope === "session",
    title: (address) => titleOf(address, cwdOf)
  };
  const nextKind = (address) => ctx.sidebarRightTabs.candidates(address).find((candidate) => candidate.id !== FOLDER_ID)?.kind;
  const open = (sessionId, address, options) => {
    const kind = nextKind(address);
    if (kind === void 0) return false;
    ctx.sidebarRight.openResourceIn(sessionId, address, { ...options, kind });
    return true;
  };
  const face = {
    models,
    api,
    host: (sessionId, tab) => ({
      entry: (path, signal) => api.entry(path, signal),
      handOff: () => {
        const current = tab();
        if (current.signal.aborted) return true;
        const params = current.navigation.params;
        return open(sessionId, current.contentId, { replaceTab: current.id, params });
      }
    }),
    openFile: (sessionId, cwd, path, paneId) => {
      const address = fileAddressFor(sessionId, cwd, path);
      if (!open(sessionId, address, { paneId })) {
        ctx.sidebarRight.openResourceIn(sessionId, address, { kind: FOLDER_KIND, paneId });
      }
    },
    openFolder: (tab, sessionId, cwd, path) => {
      tab.actions.openResource(fileAddressFor(sessionId, cwd, path), { replaceTab: true });
    }
  };
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => contained("the folder tab", () => {
    const body = ctx.slots.register({
      name: "sidebar.right.pane.tab",
      key: FOLDER_ID,
      locale: NS,
      inject: () => ({ face })
    }, FolderBody);
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
  })), "mu-dsh-files: folder type and body");
  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => contained("the folder tab title", () => ctx.slots.register({
    name: "sidebar.right.pane.tab.title",
    key: FOLDER_ID,
    inject: () => ({ face })
  }, FolderTitle))), "mu-dsh-files: folder title");
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
