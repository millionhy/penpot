// Plugin workspace proxies (F7.4). Port of app.plugins.file/file-proxy,
// app.plugins.page/page-proxy, app.plugins.viewport/viewport-proxy and
// app.plugins.history/history-subcontext, plus the selection surface of
// create-context.
//
// Registered deviations from the CLJS:
//   - every proxy reads the module store (and the canvas bridge when it is
//     mounted) instead of the potok state; a proxy minted for a page that is
//     no longer open answers undefined and refuses writes,
//   - file.createPage mints the page id and returns the proxy before the
//     commit lands, like the CLJS; a rejected commit leaves a proxy whose
//     reads answer undefined,
//   - page.background reads the stored canvas color but its setter is
//     deferred: the canvas repaints the background by reloading the page
//     model, which would drop the selection and the undo stack,
//   - page.flows and page.rulerGuides are read-only plain records; the flow
//     and guide proxies, createFlow/removeFlow and the guide writes wait for
//     the interaction and guide slices,
//   - page.openPage switches the page in place; a new browser window is not
//     part of the rewrite (no ::rt/new-window),
//   - the file version, export, validation and plugin-data members wait for
//     the versions and plugin-data slices, and every one of them throws a
//     named error instead of answering a wrong value,
//   - the history block is one canvas transaction: a begin/finish pair folds
//     the commits between them into one undo entry (lib/workspace-undo has no
//     separate transaction stack).
//
// The proxies never cache the file, the page or the viewport: every read goes
// through the store, so a commit, a page switch or a zoom shows up at once.

import { ZERO_UUID } from "@/lib/file-data";
import { checkPluginPermission } from "@/lib/plugins";
import { notValid, validNumber } from "@/lib/plugin-validation";
import {
  createShapeProxy,
  isShapeProxy,
  shapeProxyId,
  type PluginShapeProxy,
} from "@/lib/plugin-shape";
import { requireWorkspaceBridge } from "@/lib/workspace-bridge";
import { openWorkspacePage } from "@/lib/workspace-navigation";
import {
  normalizePageName,
  validPageName,
  type WorkspacePageInfo,
} from "@/lib/workspace-pages";
import { getWorkspaceState, setSelection } from "@/lib/workspace-store";
import type { WorkspaceFile } from "@/lib/workspace";

// The default canvas color (ctc/canvas); a page without :background paints
// with it.
const CANVAS_COLOR = "#E8E9EA";

const WRITE_DENIED = "Plugin doesn't have 'content:write' permission";

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function pagesIndex(file: WorkspaceFile | null): Record<string, Record<string, unknown>> {
  if (file === null) return {};
  const index = file.data["pages-index"];
  return index === undefined || index === null
    ? {}
    : (index as unknown as Record<string, Record<string, unknown>>);
}

// The open file, or null when another file replaced the one the proxy was
// minted for.
function fileOf(fileId: string): WorkspaceFile | null {
  const file = getWorkspaceState().file;
  if (file === null || file.id !== fileId) return null;
  return file;
}

function pageDataOf(fileId: string, pageId: string): Record<string, unknown> | null {
  const file = fileOf(fileId);
  if (file === null) return null;
  const page = pagesIndex(file)[pageId];
  return page === undefined || page === null ? null : page;
}

// --- Viewport ---------------------------------------------------------------

// The frozen center of the CLJS getter.
function viewportCenter(): { x: number; y: number } | null {
  const vbox = getWorkspaceState().vbox;
  if (vbox === null) return null;
  return { x: vbox.x + vbox.width / 2, y: vbox.y + vbox.height / 2 };
}

function viewportZoom(): number | null {
  return getWorkspaceState().zoom;
}

export interface PluginViewportProxy {
  center: { x: number; y: number } | null;
  zoom: number | null;
  readonly bounds: { x: number; y: number; width: number; height: number } | null;
  zoomReset(): void;
  zoomToFitAll(): void;
  zoomIntoView(shapes: unknown): void;
}

export function createViewportProxy(pluginId: string): PluginViewportProxy {
  const proxy: PluginViewportProxy = {
    get center() {
      const center = viewportCenter();
      return center === null ? null : Object.freeze(center);
    },
    // The declared type keeps the accessor pair well typed; the runtime check
    // still guards the values plugin code sends.
    set center(value: { x: number; y: number } | null) {
      const point = recordOf(value);
      const x = point === null ? null : point["x"];
      const y = point === null ? null : point["y"];
      if (!validNumber(x)) {
        notValid(pluginId, "center-x", x);
        return;
      }
      if (!validNumber(y)) {
        notValid(pluginId, "center-y", y);
        return;
      }
      requireWorkspaceBridge("viewport.center").setCenter({ x, y });
    },

    get zoom() {
      return viewportZoom();
    },
    set zoom(value: number | null) {
      if (!validNumber(value)) {
        notValid(pluginId, "zoom", value);
        return;
      }
      requireWorkspaceBridge("viewport.zoom").setZoom(value);
    },

    get bounds() {
      const vbox = getWorkspaceState().vbox;
      return vbox === null ? null : Object.freeze({ ...vbox });
    },

    zoomReset(): void {
      requireWorkspaceBridge("viewport.zoomReset").zoomReset();
    },

    zoomToFitAll(): void {
      requireWorkspaceBridge("viewport.zoomToFitAll").zoomToFitAll();
    },

    zoomIntoView(shapes: unknown): void {
      if (!Array.isArray(shapes) || !shapes.every((shape) => isShapeProxy(shape))) {
        notValid(pluginId, "zoomIntoView", "Argument should be valid shapes");
        return;
      }
      const ids: string[] = [];
      for (const shape of shapes) {
        const id = shapeProxyId(shape);
        if (id !== null) ids.push(id);
      }
      requireWorkspaceBridge("viewport.zoomIntoView").zoomIntoView(ids);
    },
  };
  return proxy;
}

// --- History ----------------------------------------------------------------

export interface PluginHistoryProxy {
  undoBlockBegin(): symbol;
  undoBlockFinish(blockId: unknown): void;
}

// The blocks a plugin opened and has not finished; a finish of a foreign or
// already finished symbol waits for the invalid-value report the CLJS gives.
const openBlocks = new Set<symbol>();

export function createHistoryProxy(pluginId: string): PluginHistoryProxy {
  return {
    undoBlockBegin(): symbol {
      if (!checkPluginPermission(pluginId, "content:write")) {
        notValid(pluginId, "undoBlockBegin", WRITE_DENIED);
        return Symbol("plugin-undo-block-denied");
      }
      const id = Symbol("plugin-undo-block");
      openBlocks.add(id);
      requireWorkspaceBridge("history.undoBlockBegin").beginUndoBlock();
      return id;
    },
    undoBlockFinish(blockId: unknown): void {
      if (!checkPluginPermission(pluginId, "content:write")) {
        notValid(pluginId, "undoBlockFinish", WRITE_DENIED);
        return;
      }
      if (typeof blockId !== "symbol" || !openBlocks.has(blockId)) {
        notValid(pluginId, "undoBlockFinish", blockId);
        return;
      }
      openBlocks.delete(blockId);
      requireWorkspaceBridge("history.undoBlockFinish").endUndoBlock();
    },
  };
}

// --- Page -------------------------------------------------------------------

export interface PluginPageProxy {
  readonly id: string;
  name: string | undefined;
  readonly root: PluginShapeProxy | null;
  readonly background: string;
  readonly flows: unknown[];
  readonly rulerGuides: unknown[];
  getRoot(): PluginShapeProxy | null;
  getShapeById(shapeId: unknown): PluginShapeProxy | null;
  findShapes(criteria: unknown): PluginShapeProxy[];
  openPage(newWindow?: unknown): Promise<void>;
  remove(): void;
  createFlow(...args: unknown[]): never;
  removeFlow(...args: unknown[]): never;
  addRulerGuide(...args: unknown[]): never;
  removeRulerGuide(...args: unknown[]): never;
  getPluginData(...args: unknown[]): never;
  setPluginData(...args: unknown[]): never;
  getPluginDataKeys(...args: unknown[]): never;
  getSharedPluginData(...args: unknown[]): never;
  setSharedPluginData(...args: unknown[]): never;
  getSharedPluginDataKeys(...args: unknown[]): never;
  addCommentThread(...args: unknown[]): never;
  removeCommentThread(...args: unknown[]): never;
  findCommentThreads(...args: unknown[]): never;
}

function pendingMember(name: string): never {
  throw new Error(
    `[PENPOT PLUGIN] '${name}' needs the workspace data layer, which is not available yet`,
  );
}

// The deferred proxies answer the same named failure whatever the plugin
// passes; the wrapper keeps the members without binding unused arguments.
function deferred(name: string): (...args: unknown[]) => never {
  return () => pendingMember(name);
}

// The page proxies a plugin holds; openPage accepts them next to the uuid
// strings (page/page-proxy?).
const pageProxies = new WeakSet<object>();

export function isPageProxy(value: unknown): boolean {
  return typeof value === "object" && value !== null && pageProxies.has(value);
}

export function pageProxyId(value: unknown): string | null {
  return isPageProxy(value) ? (value as PluginPageProxy).id : null;
}

// format/axis->orientation: the stored guide axis as the plugin reads it.
function guideOrientation(axis: unknown): string | undefined {
  if (axis === "x") return "vertical";
  if (axis === "y") return "horizontal";
  return undefined;
}

export function createPageProxy(
  pluginId: string,
  fileId: string,
  pageId: string,
): PluginPageProxy {
  const page = (): Record<string, unknown> | null => pageDataOf(fileId, pageId);

  const proxy: PluginPageProxy = {
    id: pageId,

    get name(): string | undefined {
      const data = page();
      const name = data?.["name"];
      return typeof name === "string" ? name : undefined;
    },
    set name(value: unknown) {
      const next = typeof value === "string" ? normalizePageName(value) : null;
      if (next === null || !validPageName(next)) {
        notValid(pluginId, "name", value);
        return;
      }
      if (!checkPluginPermission(pluginId, "content:write")) {
        notValid(pluginId, "name", WRITE_DENIED);
        return;
      }
      void requireWorkspaceBridge("page.name")
        .renamePage(pageId, next)
        .catch((cause: unknown) => {
          console.error("[PENPOT PLUGIN] 'page.name' failed", cause);
        });
    },

    get root(): PluginShapeProxy | null {
      return proxy.getRoot();
    },

    get background(): string {
      const value = page()?.["background"];
      return typeof value === "string" ? value : CANVAS_COLOR;
    },

    get flows(): unknown[] {
      // The page stores its flows as a map keyed by id (d/nilv ... {}), not
      // as a list; the CLJS reads it with vals.
      const flows = page()?.["flows"];
      const list = flows === null || flows === undefined || typeof flows !== "object"
        ? []
        : Object.values(flows as Record<string, unknown>);
      return list.map((flow) => {
        const record = recordOf(flow) ?? {};
        return Object.freeze({
          id: record["id"],
          name: record["name"],
          startingBoard: record["starting-frame"] ?? null,
        });
      });
    },

    get rulerGuides(): unknown[] {
      const guides = page()?.["guides"];
      const list = guides === null || guides === undefined || typeof guides !== "object"
        ? []
        : Object.values(guides as Record<string, unknown>);
      const out: unknown[] = [];
      for (const guide of list) {
        const record = recordOf(guide);
        if (record === null) continue;
        // The page-level guides are the ones without a frame-id; a guide of
        // a board belongs to that board.
        if (record["frame-id"] !== undefined && record["frame-id"] !== null) continue;
        out.push(
          Object.freeze({
            id: record["id"],
            orientation: guideOrientation(record["axis"]),
            position: record["position"],
            boardId: null,
          }),
        );
      }
      return out;
    },

    getRoot(): PluginShapeProxy | null {
      return createShapeProxy(pluginId, pageId, ZERO_UUID);
    },

    getShapeById(shapeId: unknown): PluginShapeProxy | null {
      if (typeof shapeId !== "string") {
        notValid(pluginId, "getShapeById", shapeId);
        return null;
      }
      const data = page();
      const objects = recordOf(data?.["objects"]);
      const shape = objects === null ? undefined : objects[shapeId];
      if (shape === undefined || shape === null) return null;
      return createShapeProxy(pluginId, pageId, shapeId);
    },

    // findShapes: the whole page, filtered by the criteria the CLJS supports
    // (name, name-like, type). A missing criteria matches every shape.
    findShapes(criteria: unknown): PluginShapeProxy[] {
      const filters = recordOf(criteria);
      const name = typeof filters?.["name"] === "string" ? filters["name"].toLowerCase() : null;
      const nameLike =
        typeof filters?.["name-like"] === "string" ? filters["name-like"].toLowerCase() : null;
      const type = typeof filters?.["type"] === "string" ? filters["type"] : null;
      const objects = recordOf(page()?.["objects"]) ?? {};
      const out: PluginShapeProxy[] = [];
      for (const [id, value] of Object.entries(objects)) {
        const shape = recordOf(value);
        if (shape === null) continue;
        const shapeName = typeof shape["name"] === "string" ? shape["name"].toLowerCase() : "";
        if (name !== null && shapeName !== name) continue;
        if (nameLike !== null && !shapeName.includes(nameLike)) continue;
        if (type !== null && shape["type"] !== type) continue;
        out.push(createShapeProxy(pluginId, pageId, id));
      }
      return out;
    },

    openPage(newWindow?: unknown): Promise<void> {
      // The rewrite opens the page in place; it has no second window.
      void newWindow;
      if (!checkPluginPermission(pluginId, "content:read")) {
        notValid(pluginId, "openPage", "Plugin doesn't have 'content:read' permission");
        return Promise.resolve();
      }
      if (page() === null) {
        notValid(pluginId, "openPage", "Page not found");
        return Promise.resolve();
      }
      openWorkspacePage(pageId);
      return Promise.resolve();
    },

    remove(): void {
      if (!checkPluginPermission(pluginId, "content:write")) {
        notValid(pluginId, "remove", WRITE_DENIED);
        return;
      }
      const file = fileOf(fileId);
      if (file === null || page() === null) {
        notValid(pluginId, "remove", "Page not found");
        return;
      }
      const pages = file.data.pages ?? [];
      if (pages.length <= 1) {
        notValid(pluginId, "remove", "Cannot remove the last page of the file");
        return;
      }
      void requireWorkspaceBridge("page.remove")
        .deletePage(pageId)
        .catch((cause: unknown) => {
          console.error("[PENPOT PLUGIN] 'page.remove' failed", cause);
        });
    },

    createFlow: deferred("createFlow"),
    removeFlow: deferred("removeFlow"),
    addRulerGuide: deferred("addRulerGuide"),
    removeRulerGuide: deferred("removeRulerGuide"),
    getPluginData: deferred("getPluginData"),
    setPluginData: deferred("setPluginData"),
    getPluginDataKeys: deferred("getPluginDataKeys"),
    getSharedPluginData: deferred("getSharedPluginData"),
    setSharedPluginData: deferred("setSharedPluginData"),
    getSharedPluginDataKeys: deferred("getSharedPluginDataKeys"),
    addCommentThread: deferred("addCommentThread"),
    removeCommentThread: deferred("removeCommentThread"),
    findCommentThreads: deferred("findCommentThreads"),
  } as PluginPageProxy;

  pageProxies.add(proxy);
  return proxy;
}

// --- File -------------------------------------------------------------------

export interface PluginFileProxy {
  readonly id: string;
  readonly name: string | undefined;
  readonly revn: number | undefined;
  readonly pages: unknown[];
  getPages(): unknown[];
  createPage(): unknown | null;
  validate(...args: unknown[]): never;
  export(...args: unknown[]): never;
  findVersions(...args: unknown[]): never;
  saveVersion(...args: unknown[]): never;
  getPluginData(...args: unknown[]): never;
  setPluginData(...args: unknown[]): never;
  getPluginDataKeys(...args: unknown[]): never;
  getSharedPluginData(...args: unknown[]): never;
  setSharedPluginData(...args: unknown[]): never;
  getSharedPluginDataKeys(...args: unknown[]): never;
}

function filePages(file: WorkspaceFile | null): WorkspacePageInfo[] {
  if (file === null) return [];
  const pages = file.data.pages ?? [];
  const index = pagesIndex(file);
  const out: WorkspacePageInfo[] = [];
  for (const id of pages) {
    const page = index[id];
    const name = page === undefined || page === null ? undefined : page["name"];
    out.push({ id, name: typeof name === "string" ? name : "" });
  }
  return out;
}

export function createFileProxy(pluginId: string, fileId: string): PluginFileProxy {
  const proxy: PluginFileProxy = {
    id: fileId,

    get name(): string | undefined {
      return fileOf(fileId)?.name;
    },

    get revn(): number | undefined {
      const revn = fileOf(fileId)?.revn;
      return typeof revn === "number" ? revn : undefined;
    },

    get pages(): unknown[] {
      return proxy.getPages();
    },

    getPages(): unknown[] {
      const file = fileOf(fileId);
      if (file === null) return [];
      return filePages(file).map((page) =>
        createPageProxy(pluginId, fileId, page.id),
      );
    },

    // createPage: the id is minted here so the proxy can come back at once,
    // like the CLJS (dw/create-page commits in the background).
    createPage(): unknown | null {
      if (!checkPluginPermission(pluginId, "content:write")) {
        notValid(pluginId, "createPage", WRITE_DENIED);
        return null;
      }
      if (fileOf(fileId) === null) return null;
      const id = crypto.randomUUID();
      const proxyForPage = createPageProxy(pluginId, fileId, id);
      void requireWorkspaceBridge("file.createPage")
        .createPage(id)
        .catch((cause: unknown) => {
          console.error("[PENPOT PLUGIN] 'file.createPage' failed", cause);
        });
      return proxyForPage;
    },

    validate: deferred("validate"),
    export: deferred("export"),
    findVersions: deferred("findVersions"),
    saveVersion: deferred("saveVersion"),
    getPluginData: deferred("getPluginData"),
    setPluginData: deferred("setPluginData"),
    getPluginDataKeys: deferred("getPluginDataKeys"),
    getSharedPluginData: deferred("getSharedPluginData"),
    setSharedPluginData: deferred("setSharedPluginData"),
    getSharedPluginDataKeys: deferred("getSharedPluginDataKeys"),
  } as PluginFileProxy;

  return proxy;
}

// --- Context members --------------------------------------------------------

// getFile: null until a file is open.
export function currentFileProxy(pluginId: string): PluginFileProxy | null {
  const file = getWorkspaceState().file;
  if (file === null) return null;
  return createFileProxy(pluginId, file.id);
}

// getPage: null until both the file and the page are open.
export function currentPageProxy(pluginId: string): PluginPageProxy | null {
  const state = getWorkspaceState();
  if (state.file === null || state.pageId === null) return null;
  return createPageProxy(pluginId, state.file.id, state.pageId);
}

// getRoot: the page root frame, the shape every page carries as ZERO_UUID.
export function rootShapeProxy(pluginId: string): PluginShapeProxy | null {
  const state = getWorkspaceState();
  if (state.file === null || state.pageId === null) return null;
  return createShapeProxy(pluginId, state.pageId, ZERO_UUID);
}

// getSelectedShapes: one proxy per selected id, in selection order.
export function selectedShapeProxies(pluginId: string): PluginShapeProxy[] {
  const state = getWorkspaceState();
  if (state.pageId === null) return [];
  return state.selection.map((id) => createShapeProxy(pluginId, state.pageId as string, id));
}

// select-shapes: the ids of the given proxies, in order, duplicates dropped
// (lib/workspace-selection owns the ordered-unique rule).
export function selectShapeProxies(shapes: unknown): boolean {
  if (!Array.isArray(shapes) || !shapes.every((shape) => isShapeProxy(shape))) {
    return false;
  }
  const ids: string[] = [];
  for (const shape of shapes) {
    const id = shapeProxyId(shape);
    if (id === null) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  setSelection(ids);
  return true;
}
