// Plugin host context (F7.3). Port of create-context in app.plugins.api: the
// object the plugins runtime asks for through the context builder, holding
// the state a sandboxed plugin can read and the listener registry that feeds
// its events.
//
// Registered deviations from the CLJS:
//   - the workspace APIs (root, currentFile, currentPage, selection,
//     viewport, history, library, fonts and every write method) wait for the
//     workspace editor: reads answer null (an empty array for the
//     selection), writes throw a named error, and a valid selection set
//     throws the same way,
//   - currentUser and activeUsers answer null and [] for the same reason;
//     the CLJS proxies read the profile and the presence from the store,
//   - the theme reads the class ThemeManager keeps on <html>, which is the
//     resolved value resolve-theme produces at the store,
//   - only themechange has a dispatcher until the workspace lands with F9:
//     the other state-change events register like the CLJS but never fire,
//   - the shapeId listener prop is stored as given; the CLJS parses it into
//     a uuid at registration.

import { config } from "@/lib/config";
import {
  NATURAL_CHILD_ORDERING,
  THROW_VALIDATION_ERRORS,
  getPluginFlag,
  setPluginFlag,
} from "@/lib/plugin-flags";
import { checkPluginPermission } from "@/lib/plugins";

// --- Validation -----------------------------------------------------------

// u/not-valid: a version >= 2 plugin gets a thrown error on a validation
// failure, an older one only a console error and a null answer.
export function notValid(pluginId: string, code: string, value?: unknown): null {
  const message =
    value === undefined || value === null
      ? `[PENPOT PLUGIN] Value not valid. Code: ${code}`
      : `[PENPOT PLUGIN] Value not valid: ${String(value)}. Code: ${code}`;
  if (getPluginFlag(pluginId, THROW_VALIDATION_ERRORS) === true) {
    throw new Error(message);
  }
  console.error(message);
  return null;
}

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
// dispatcher, like the try/catch the CLJS wraps around every callback.
function safeCallback(callback: PluginListenerCallback): PluginListenerCallback {
  return (value?: unknown) => {
    try {
      callback(value);
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
// passed that test.
export function dispatchPluginEvent(type: string, value?: unknown): void {
  for (const listener of [...pluginListeners.values()]) {
    if (listener.type === type) listener.emit(value);
  }
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

// --- Workspace placeholders -----------------------------------------------

const WORKSPACE_PENDING = "needs the workspace editor, which arrives with F9";

// The workspace write surface answers with a named error until the editor
// exists; a silent undefined would mislead plugin authors the CLJS never
// reaches, because their workspace is always loaded.
function pendingWorkspace(name: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`[PENPOT PLUGIN] '${name}' ${WORKSPACE_PENDING}`);
  };
}

// --- Context --------------------------------------------------------------

// The object the runtime keeps per plugin; only the members the loader and
// the public API touch are implemented, the rest are the placeholders above.
export function createPluginContext(pluginId: string) {
  return {
    $plugin: pluginId,

    get version(): string {
      return config.version ?? "";
    },
    get root(): null {
      return null;
    },
    get currentFile(): null {
      return null;
    },
    get currentPage(): null {
      return null;
    },
    get viewport(): null {
      return null;
    },
    get history(): null {
      return null;
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
    get selection(): unknown[] {
      return [];
    },
    set selection(value: unknown) {
      if (!Array.isArray(value)) {
        notValid(pluginId, "selection", value);
        return;
      }
      pendingWorkspace("selection")();
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

    shapesColors: pendingWorkspace("shapesColors"),
    replaceColor: pendingWorkspace("replaceColor"),
    createBoard: pendingWorkspace("createBoard"),
    createRectangle: pendingWorkspace("createRectangle"),
    createEllipse: pendingWorkspace("createEllipse"),
    createText: pendingWorkspace("createText"),
    createPath: pendingWorkspace("createPath"),
    createBoolean: pendingWorkspace("createBoolean"),
    createShapeFromSvg: pendingWorkspace("createShapeFromSvg"),
    createShapeFromSvgWithImages: pendingWorkspace("createShapeFromSvgWithImages"),
    group: pendingWorkspace("group"),
    ungroup: pendingWorkspace("ungroup"),
    uploadMediaUrl: pendingWorkspace("uploadMediaUrl"),
    uploadMediaData: pendingWorkspace("uploadMediaData"),
    generateMarkup: pendingWorkspace("generateMarkup"),
    generateStyle: pendingWorkspace("generateStyle"),
    generateFontFaces: pendingWorkspace("generateFontFaces"),
    openViewer: pendingWorkspace("openViewer"),
    createPage: pendingWorkspace("createPage"),
    openPage: pendingWorkspace("openPage"),
    alignHorizontal: pendingWorkspace("alignHorizontal"),
    alignVertical: pendingWorkspace("alignVertical"),
    distributeHorizontal: pendingWorkspace("distributeHorizontal"),
    distributeVertical: pendingWorkspace("distributeVertical"),
    flatten: pendingWorkspace("flatten"),
    createVariantFromComponents: pendingWorkspace("createVariantFromComponents"),
    waitForLayoutUpdate: pendingWorkspace("waitForLayoutUpdate"),
  };
}
