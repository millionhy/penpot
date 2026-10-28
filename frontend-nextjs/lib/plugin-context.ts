// Plugin host context (F7.3/F7.4). Port of create-context in app.plugins.api:
// the object the plugins runtime asks for through the context builder, holding
// the live workspace proxies, the creation and arrange methods, and the
// listener registry that feeds the plugin events.
//
// Registered deviations from the CLJS:
//   - the proxies read the module store (and the canvas bridge) instead of
//     the potok state; they are in lib/plugin-shape and lib/plugin-workspace,
//   - the events are computed here from a snapshot of the store, subscribed
//     once, instead of one add-watch per listener: the rewrite has no potok
//     state to watch, but the change tests and the 10 ms debounce match
//     app.plugins.events,
//   - contentsave fires after a committed workspace change (the shell calls
//     notifyPluginContentSaved); the CLJS watches :persistence :status turn
//     to :saved,
//   - createPage checks content:write, which the CLJS create-page does not,
//   - shape structure (group/ungroup/flatten/boolean/text/path/svg), the
//     color and library data, the media pipeline, the code and font
//     generators and the viewer route are not wired yet; each answers a
//     named error instead of a wrong value,
//   - currentUser and activeUsers answer null and [] until the session and
//     the presence arrive; library and fonts answer null until their slices
//     arrive,
//   - the theme reads the class ThemeManager keeps on <html>, which is the
//     resolved value resolve-theme produces at the store,
//   - the shapeId listener prop is stored as given; the CLJS parses it into
//     a uuid at registration.

import { config } from "@/lib/config";
import {
  NATURAL_CHILD_ORDERING,
  THROW_VALIDATION_ERRORS,
  getPluginFlag,
  setPluginFlag,
} from "@/lib/plugin-flags";
import { notValid } from "@/lib/plugin-validation";
import {
  createShapeProxy,
  isShapeProxy,
  shapeProxyId,
  type PluginShapeProxy,
} from "@/lib/plugin-shape";
import {
  createFileProxy,
  createHistoryProxy,
  createPageProxy,
  createViewportProxy,
  currentFileProxy,
  currentPageProxy,
  pageProxyId,
  rootShapeProxy,
  selectShapeProxies,
  selectedShapeProxies,
  type PluginFileProxy,
  type PluginHistoryProxy,
  type PluginPageProxy,
  type PluginViewportProxy,
} from "@/lib/plugin-workspace";
import { checkPluginPermission } from "@/lib/plugins";
import { requireWorkspaceBridge } from "@/lib/workspace-bridge";
import { openWorkspacePage } from "@/lib/workspace-navigation";
import { getWorkspaceState, subscribeWorkspace } from "@/lib/workspace-store";
import type { WorkspaceObjects } from "@/lib/workspace";

export { notValid } from "@/lib/plugin-validation";

// --- Event listeners ------------------------------------------------------

// events.cljs add-listener: every registration watches the store and the
// callbacks are debounced 10 ms so a burst of changes delivers once. The
// CLJS stores a symbol key per registration; the shell key is the same
// symbol and the registry is a Map.
export interface PluginListenerProps {
  shapeId?: unknown;
}

export type PluginListenerCallback = (value?: unknown) => void;

interface PluginListener {
  type: string;
  pluginId: string;
  props: PluginListenerProps;
  emit: PluginListenerCallback;
}

const pluginListeners = new Map<symbol, PluginListener>();

function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
}

// A throwing plugin callback must not starve the other listeners nor the
// dispatcher, like the try/catch the CLJS wraps around every callback. The
// arguments pass through untouched, so a void event (contentsave) reaches
// the callback with none.
function safeCallback(callback: PluginListenerCallback): PluginListenerCallback {
  return (...args) => {
    try {
      callback(...args);
    } catch (cause) {
      console.error(cause);
    }
  };
}

export function addPluginListener(
  pluginId: string,
  type: string,
  callback: PluginListenerCallback,
  props?: PluginListenerProps,
): symbol {
  startPluginWorkspaceEvents();
  const key = Symbol(type);
  pluginListeners.set(key, {
    type,
    pluginId,
    props: props ?? {},
    emit: debounce(safeCallback(callback), 10),
  });
  return key;
}

export function removePluginListener(listenerId: symbol): void {
  pluginListeners.delete(listenerId);
}

// handle-state-change: the CLJS computes the new value per event type and
// skips ::not-changed; the shell dispatcher receives values that already
// passed that test. No value means ::void, which runs the callback with no
// arguments.
export function dispatchPluginEvent(type: string, value?: unknown): void {
  for (const listener of [...pluginListeners.values()]) {
    if (listener.type !== type) continue;
    if (value === undefined) listener.emit();
    else listener.emit(value);
  }
}

// --- Workspace events -----------------------------------------------------

// The slice handle-state-change reads: the current file and page, the
// selection and the live objects (dsh/lookup-shape reads the latter).
interface WorkspaceSnapshot {
  fileId: string | null;
  pageId: string | null;
  selection: readonly string[];
  objects: WorkspaceObjects | null;
}

function workspaceSnapshot(): WorkspaceSnapshot {
  const state = getWorkspaceState();
  return {
    fileId: state.file === null ? null : state.file.id,
    pageId: state.pageId,
    selection: state.selection,
    objects: state.objects,
  };
}

function shapeAt(objects: WorkspaceObjects | null, shapeId: string): unknown {
  if (objects === null) return undefined;
  return objects[shapeId];
}

interface WorkspaceEventResult {
  changed: boolean;
  value?: unknown;
}

const NOT_CHANGED: WorkspaceEventResult = { changed: false };

// handle-state-change, one branch per event type. A changed value is what the
// callback receives; ::void (contentsave) is dispatched without a value by
// notifyPluginContentSaved.
function workspaceEventValue(
  listener: PluginListener,
  old: WorkspaceSnapshot,
  next: WorkspaceSnapshot,
): WorkspaceEventResult {
  switch (listener.type) {
    case "finish":
      // Only the open file going away counts, not a page or a selection
      // change.
      return old.fileId !== null && next.fileId === null
        ? { changed: true, value: old.fileId }
        : NOT_CHANGED;

    case "filechange":
      if (old.fileId === next.fileId) return NOT_CHANGED;
      return {
        changed: true,
        value: next.fileId === null ? null : createFileProxy(listener.pluginId, next.fileId),
      };

    case "pagechange":
      if (old.pageId === next.pageId) return NOT_CHANGED;
      return {
        changed: true,
        value:
          next.fileId === null || next.pageId === null
            ? null
            : createPageProxy(listener.pluginId, next.fileId, next.pageId),
      };

    case "selectionchange":
      // The CLJS compares the selected set by identity; the store replaces
      // the array on every selection write, so the array itself is the test.
      if (old.selection === next.selection) return NOT_CHANGED;
      return { changed: true, value: [...next.selection] };

    case "shapechange": {
      const shapeId = typeof listener.props.shapeId === "string" ? listener.props.shapeId : null;
      if (shapeId === null) return NOT_CHANGED;
      const oldShape = shapeAt(old.objects, shapeId);
      const nextShape = shapeAt(next.objects, shapeId);
      if (
        oldShape === nextShape &&
        next.fileId !== null &&
        next.pageId !== null
      ) {
        return NOT_CHANGED;
      }
      return {
        changed: true,
        value:
          next.fileId === null || next.pageId === null
            ? null
            : createShapeProxy(listener.pluginId, next.pageId, shapeId),
      };
    }

    default:
      return NOT_CHANGED;
  }
}

let workspaceEventsStarted = false;
let previousSnapshot: WorkspaceSnapshot | null = null;

// One store subscription feeds every listener: computing the value per
// listener keeps the shapeId props and the per-plugin proxies right.
export function startPluginWorkspaceEvents(): void {
  if (workspaceEventsStarted) return;
  workspaceEventsStarted = true;
  previousSnapshot = workspaceSnapshot();
  subscribeWorkspace(() => {
    const next = workspaceSnapshot();
    const old = previousSnapshot;
    previousSnapshot = next;
    if (old === null) return;
    for (const listener of [...pluginListeners.values()]) {
      try {
        const result = workspaceEventValue(listener, old, next);
        if (result.changed) listener.emit(result.value);
      } catch (cause) {
        console.error(cause);
      }
    }
  });
}

// The commit landed, which is the rewrite's :persistence/:status -> :saved;
// the CLJS dispatches ::void so the callback runs without a value.
export function notifyPluginContentSaved(): void {
  dispatchPluginEvent("contentsave");
}

// --- Theme ----------------------------------------------------------------

// get-theme resolves the profile setting against the OS preference; the
// shell reads the class ThemeManager wrote, which is the same value.
export function currentPluginTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.classList.contains("light") ? "light" : "dark";
}

let lastNotifiedTheme: string | null = null;

// The themechange branch of handle-state-change fires only when the resolved
// value changed; the dedupe lives here because applyTheme re-runs on every
// effect pass.
export function notifyPluginThemeChange(theme: "light" | "dark"): void {
  if (theme === lastNotifiedTheme) return;
  lastNotifiedTheme = theme;
  dispatchPluginEvent("themechange", theme);
}

// --- Flags proxy ----------------------------------------------------------

function pluginFlags(pluginId: string) {
  return {
    get naturalChildOrdering(): boolean {
      return getPluginFlag(pluginId, NATURAL_CHILD_ORDERING) === true;
    },
    set naturalChildOrdering(value: unknown) {
      if (typeof value !== "boolean") {
        notValid(pluginId, "naturalChildOrdering", value);
        return;
      }
      setPluginFlag(pluginId, NATURAL_CHILD_ORDERING, value);
    },
    get throwValidationErrors(): boolean {
      return getPluginFlag(pluginId, THROW_VALIDATION_ERRORS) === true;
    },
    set throwValidationErrors(value: unknown) {
      if (typeof value !== "boolean") {
        notValid(pluginId, "throwValidationErrors", value);
        return;
      }
      setPluginFlag(pluginId, THROW_VALIDATION_ERRORS, value);
    },
  };
}

// --- Local storage proxy --------------------------------------------------

// local_storage.cljs local-storage-proxy: every key lives under
// "penpot-plugins:<plugin-id>/" and the allow:localstorage permission gates
// all four operations.
function pluginLocalStorage(pluginId: string) {
  const prefix = `penpot-plugins:${pluginId}/`;

  const allowed = (operation: string, key: unknown): key is string => {
    if (!checkPluginPermission(pluginId, "allow:localstorage")) {
      notValid(pluginId, operation, "Plugin doesn't have 'allow:localstorage' permission");
      return false;
    }
    if (typeof key !== "string") {
      notValid(pluginId, operation, "The key must be a string");
      return false;
    }
    return true;
  };

  return {
    getItem(key: unknown): string | null {
      if (!allowed("getItem", key)) return null;
      return window.localStorage.getItem(prefix + key);
    },
    setItem(key: unknown, value: string): void {
      if (!allowed("setItem", key)) return;
      window.localStorage.setItem(prefix + key, value);
    },
    removeItem(key: unknown): void {
      if (!allowed("removeItem", key)) return;
      window.localStorage.removeItem(prefix + key);
    },
    getKeys(): string[] {
      return Object.keys(window.localStorage)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    },
  };
}

// --- Workspace helpers ----------------------------------------------------

const WRITE_DENIED = "Plugin doesn't have 'content:write' permission";

// A member whose backing slice is not in the rewrite yet answers a named
// error; a silent undefined would mislead plugin authors the CLJS never
// reaches, because their workspace always has the data.
type PendingMember = (...args: unknown[]) => never;

function pendingMember(name: string, area: string): PendingMember {
  return () => {
    throw new Error(`[PENPOT PLUGIN] '${name}' needs ${area}, which is not available yet`);
  };
}

// The ids of a shape-proxy array, in argument order, duplicates dropped: the
// arrange commands of the CLJS collect the $id of every proxy into a set.
function proxyIds(shapes: unknown): string[] | null {
  if (!Array.isArray(shapes) || !shapes.every((shape) => isShapeProxy(shape))) {
    return null;
  }
  const ids: string[] = [];
  for (const shape of shapes) {
    const id = shapeProxyId(shape);
    if (id === null) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

// api.cljs create-shape: one 100x100 shape at the page origin, under the
// page root, committed in the background. The id is minted here so the proxy
// comes back before the commit lands.
function createShapeForPlugin(
  pluginId: string,
  type: "frame" | "rect" | "ellipse",
): PluginShapeProxy | null {
  const state = getWorkspaceState();
  if (state.file === null || state.pageId === null) return null;
  const pageId = state.pageId;
  const id = crypto.randomUUID();
  const proxy = createShapeProxy(pluginId, pageId, id);
  void requireWorkspaceBridge("create-shape")
    .createShape(id, type, { x: 0, y: 0, width: 100, height: 100 })
    .catch((cause: unknown) => {
      console.error("[PENPOT PLUGIN] 'create-shape' failed", cause);
    });
  return proxy;
}

function alignShapes(
  pluginId: string,
  shapes: unknown,
  direction: unknown,
  horizontal: boolean,
  code: string,
): void {
  const axis = horizontal
    ? direction === "left"
      ? "hleft"
      : direction === "center"
        ? "hcenter"
        : direction === "right"
          ? "hright"
          : null
    : direction === "top"
      ? "vtop"
      : direction === "center"
        ? "vcenter"
        : direction === "bottom"
          ? "vbottom"
          : null;
  if (axis === null) {
    notValid(pluginId, `${code}-direction`, "Direction not valid");
    return;
  }
  const ids = proxyIds(shapes);
  if (ids === null) {
    notValid(pluginId, `${code}-shapes`, "Not valid shapes");
    return;
  }
  void requireWorkspaceBridge(code)
    .alignObjects(ids, axis)
    .catch((cause: unknown) => {
      console.error(`[PENPOT PLUGIN] '${code}' failed`, cause);
    });
}

function distributeShapes(
  pluginId: string,
  shapes: unknown,
  axis: "horizontal" | "vertical",
  code: string,
): void {
  const ids = proxyIds(shapes);
  if (ids === null) {
    notValid(pluginId, `${code}-shapes`, "Not valid shapes");
    return;
  }
  void requireWorkspaceBridge(code)
    .distributeObjects(ids, axis)
    .catch((cause: unknown) => {
      console.error(`[PENPOT PLUGIN] '${code}' failed`, cause);
    });
}

// uuid/parse*: the 8-4-4-4-12 hex form the CLJS accepts from a string.
const PAGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validPageUuid(value: string): boolean {
  return PAGE_UUID.test(value);
}

// --- Context --------------------------------------------------------------

// The object the runtime keeps per plugin; the workspace members read the
// live store through the proxies, the deferred ones answer a named error.
export function createPluginContext(pluginId: string) {
  return {
    $plugin: pluginId,

    get version(): string {
      return config.version ?? "";
    },
    get root(): PluginShapeProxy | null {
      return rootShapeProxy(pluginId);
    },
    get currentFile(): PluginFileProxy | null {
      return currentFileProxy(pluginId);
    },
    get currentPage(): PluginPageProxy | null {
      return currentPageProxy(pluginId);
    },
    get viewport(): PluginViewportProxy {
      return createViewportProxy(pluginId);
    },
    get history(): PluginHistoryProxy {
      return createHistoryProxy(pluginId);
    },
    get library(): null {
      return null;
    },
    get fonts(): null {
      return null;
    },
    get currentUser(): null {
      return null;
    },
    get activeUsers(): unknown[] {
      return [];
    },
    get selection(): PluginShapeProxy[] {
      return selectedShapeProxies(pluginId);
    },
    set selection(value: unknown) {
      if (!selectShapeProxies(value)) {
        notValid(pluginId, "selection", value);
      }
    },
    get theme(): "light" | "dark" {
      return currentPluginTheme();
    },
    get flags() {
      return pluginFlags(pluginId);
    },
    get localStorage() {
      return pluginLocalStorage(pluginId);
    },

    addListener(
      type: string,
      callback: PluginListenerCallback,
      props?: PluginListenerProps,
    ): symbol {
      return addPluginListener(pluginId, type, callback, props);
    },
    removeListener(listenerId: symbol): void {
      removePluginListener(listenerId);
    },

    getViewport(): PluginViewportProxy {
      return createViewportProxy(pluginId);
    },
    getFile(): PluginFileProxy | null {
      return currentFileProxy(pluginId);
    },
    getPage(): PluginPageProxy | null {
      return currentPageProxy(pluginId);
    },
    getSelectedShapes(): PluginShapeProxy[] {
      return selectedShapeProxies(pluginId);
    },
    getRoot(): PluginShapeProxy | null {
      return rootShapeProxy(pluginId);
    },
    getTheme(): "light" | "dark" {
      return currentPluginTheme();
    },
    getCurrentUser(): null {
      return null;
    },
    getActiveUsers(): unknown[] {
      return [];
    },

    shapesColors: pendingMember("shapesColors", "the color and library data"),
    replaceColor: pendingMember("replaceColor", "the color and library data"),

    createBoard(): PluginShapeProxy | null {
      return createShapeForPlugin(pluginId, "frame");
    },
    createRectangle(): PluginShapeProxy | null {
      return createShapeForPlugin(pluginId, "rect");
    },
    createEllipse(): PluginShapeProxy | null {
      return createShapeForPlugin(pluginId, "ellipse");
    },
    createText: pendingMember("createText", "the shape structure editor"),
    createPath: pendingMember("createPath", "the shape structure editor"),
    createBoolean: pendingMember("createBoolean", "the shape structure editor"),
    createShapeFromSvg: pendingMember("createShapeFromSvg", "the shape structure editor"),
    createShapeFromSvgWithImages: pendingMember(
      "createShapeFromSvgWithImages",
      "the shape structure editor",
    ),
    group: pendingMember("group", "the shape structure editor"),
    ungroup: pendingMember("ungroup", "the shape structure editor"),
    flatten: pendingMember("flatten", "the shape structure editor"),
    createVariantFromComponents: pendingMember(
      "createVariantFromComponents",
      "the shape structure editor",
    ),

    uploadMediaUrl: pendingMember("uploadMediaUrl", "the media pipeline"),
    uploadMediaData: pendingMember("uploadMediaData", "the media pipeline"),
    generateMarkup: pendingMember("generateMarkup", "the code generator"),
    generateStyle: pendingMember("generateStyle", "the code generator"),
    generateFontFaces: pendingMember("generateFontFaces", "the font pipeline"),
    openViewer: pendingMember("openViewer", "the viewer route"),

    // api.cljs createPage: mint the id, commit the page in the background
    // and return its proxy at once. Unlike the CLJS it requires content:write.
    createPage(): PluginPageProxy | null {
      if (!checkPluginPermission(pluginId, "content:write")) {
        notValid(pluginId, "createPage", WRITE_DENIED);
        return null;
      }
      const state = getWorkspaceState();
      if (state.file === null) return null;
      const fileId = state.file.id;
      const id = crypto.randomUUID();
      const proxy = createPageProxy(pluginId, fileId, id);
      void requireWorkspaceBridge("createPage")
        .createPage(id)
        .catch((cause: unknown) => {
          console.error("[PENPOT PLUGIN] 'createPage' failed", cause);
        });
      return proxy;
    },

    // api.cljs openPage: a page proxy or a page uuid. The rewrite has no
    // second window, so a newWindow request opens the page in place.
    openPage(page: unknown, newWindow?: unknown): Promise<void> {
      void newWindow;
      const fromProxy = pageProxyId(page);
      const id =
        fromProxy ?? (typeof page === "string" && validPageUuid(page) ? page : null);
      if (id === null) {
        notValid(pluginId, "openPage", "Expected a Page object or a page UUID string");
        return Promise.resolve();
      }
      const state = getWorkspaceState();
      const file = state.file;
      const known =
        file !== null &&
        (file.data["pages-index"] as Record<string, unknown> | undefined)?.[id] !== undefined;
      if (!known) {
        notValid(pluginId, "openPage", "Page not found");
        return Promise.resolve();
      }
      if (state.pageId === id) return Promise.resolve();
      openWorkspacePage(id);
      return Promise.resolve();
    },

    alignHorizontal(shapes: unknown, direction: unknown): void {
      alignShapes(pluginId, shapes, direction, true, "alignHorizontal");
    },
    alignVertical(shapes: unknown, direction: unknown): void {
      alignShapes(pluginId, shapes, direction, false, "alignVertical");
    },
    distributeHorizontal(shapes: unknown): void {
      distributeShapes(pluginId, shapes, "horizontal", "distributeHorizontal");
    },
    distributeVertical(shapes: unknown): void {
      distributeShapes(pluginId, shapes, "vertical", "distributeVertical");
    },

    waitForLayoutUpdate: pendingMember("waitForLayoutUpdate", "the layout engine"),
  };
}
