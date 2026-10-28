// Unit tests for the plugin host context (create-context in
// app.plugins.api): the theme read and its themechange dispatch, the
// listener registry with its debounce and per-listener error guard, the
// flags and localStorage proxies with their validation, the workspace
// proxies and the store-driven events. Every test re-imports the modules so
// the module state (listeners, flags, the theme dedupe, the store
// subscription) starts clean.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rpc", () => ({ cmd: vi.fn() }));

import { config } from "@/lib/config";
import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceFile, WorkspaceObjects } from "@/lib/workspace";

let context: typeof import("@/lib/plugin-context");
let flags: typeof import("@/lib/plugin-flags");
let plugins: typeof import("@/lib/plugins");
let store: typeof import("@/lib/workspace-store");

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  context = await import("@/lib/plugin-context");
  flags = await import("@/lib/plugin-flags");
  plugins = await import("@/lib/plugins");
  store = await import("@/lib/workspace-store");
  store.resetWorkspaceState();
  plugins.initRegistryFromProfile(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// --- fixtures ---------------------------------------------------------------

function stubHtmlClass(theme: string): void {
  vi.stubGlobal("document", {
    documentElement: {
      classList: { contains: (name: string) => name === theme },
    },
  });
}

function stubLocalStorage(seed: Record<string, string> = {}): Record<string, unknown> {
  const storage: Record<string, unknown> = { ...seed };
  storage.getItem = (key: string) =>
    typeof storage[key] === "string" ? (storage[key] as string) : null;
  storage.setItem = (key: string, value: unknown) => {
    storage[key] = String(value);
  };
  storage.removeItem = (key: string) => {
    delete storage[key];
  };
  vi.stubGlobal("window", { localStorage: storage });
  return storage;
}

function seedRegistryEntry(permissions: string[]): void {
  plugins.initRegistryFromProfile({
    props: {
      plugins: {
        ids: ["plugin-a"],
        data: {
          "plugin-a": {
            "plugin-id": "plugin-a",
            name: "Plugin A",
            host: "https://plugins.example",
            code: "plugin.js",
            permissions,
          },
        },
      },
    },
  });
}

// --- theme ------------------------------------------------------------------

describe("theme", () => {
  it("reads the resolved theme from the html class", () => {
    stubHtmlClass("light");
    expect(context.currentPluginTheme()).toBe("light");
    stubHtmlClass("default");
    expect(context.currentPluginTheme()).toBe("dark");
  });

  it("defaults to dark without a document", () => {
    expect(context.currentPluginTheme()).toBe("dark");
  });

  it("exposes the theme through the context getter", () => {
    stubHtmlClass("light");
    expect(context.createPluginContext("plugin-a").theme).toBe("light");
  });

  it("dispatches themechange once per change, after the debounce", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    context.addPluginListener("plugin-a", "themechange", callback);

    context.notifyPluginThemeChange("light");
    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledWith("light");

    // The dedupe keeps the CLJS ::not-changed semantics.
    context.notifyPluginThemeChange("light");
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledTimes(1);

    context.notifyPluginThemeChange("dark");
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith("dark");
  });
});

// --- listener registry ------------------------------------------------------

describe("listener registry", () => {
  it("debounces a burst into one callback with the last value", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    context.addPluginListener("plugin-a", "themechange", callback);

    context.dispatchPluginEvent("themechange", "light");
    context.dispatchPluginEvent("themechange", "dark");
    vi.advanceTimersByTime(10);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("dark");
  });

  it("stops calling a removed listener", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const key = context.addPluginListener("plugin-a", "themechange", callback);

    context.removePluginListener(key);
    context.dispatchPluginEvent("themechange", "light");
    vi.advanceTimersByTime(10);

    expect(callback).not.toHaveBeenCalled();
  });

  it("ignores events of other types", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    context.addPluginListener("plugin-a", "finish", callback);

    context.dispatchPluginEvent("themechange", "light");
    vi.advanceTimersByTime(10);

    expect(callback).not.toHaveBeenCalled();
  });

  it("survives a throwing callback and keeps notifying the rest", () => {
    vi.useFakeTimers();
    const throwing = vi.fn(() => {
      throw new Error("boom");
    });
    const other = vi.fn();
    context.addPluginListener("plugin-a", "themechange", throwing);
    context.addPluginListener("plugin-b", "themechange", other);

    context.dispatchPluginEvent("themechange", "light");
    vi.advanceTimersByTime(10);

    expect(other).toHaveBeenCalledWith("light");
    expect(console.error).toHaveBeenCalled();
  });

  it("wires the context methods to the same registry", () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const ctx = context.createPluginContext("plugin-a");

    const key = ctx.addListener("themechange", callback);
    context.dispatchPluginEvent("themechange", "dark");
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledWith("dark");

    ctx.removeListener(key);
    context.dispatchPluginEvent("themechange", "light");
    vi.advanceTimersByTime(10);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

// --- flags proxy ------------------------------------------------------------

describe("flags proxy", () => {
  it("initializes version 2 plugins hardened", () => {
    flags.initPluginFlags("plugin-a", 2);
    const ctx = context.createPluginContext("plugin-a");
    expect(ctx.flags.throwValidationErrors).toBe(true);
    expect(ctx.flags.naturalChildOrdering).toBe(false);
  });

  it("reads and writes naturalChildOrdering", () => {
    flags.initPluginFlags("plugin-a", 1);
    const ctx = context.createPluginContext("plugin-a");
    expect(ctx.flags.naturalChildOrdering).toBe(false);

    ctx.flags.naturalChildOrdering = true;
    expect(ctx.flags.naturalChildOrdering).toBe(true);
    expect(flags.getPluginFlag("plugin-a", flags.NATURAL_CHILD_ORDERING)).toBe(true);
  });

  it("rejects a non-boolean write with a console error for version 1", () => {
    flags.initPluginFlags("plugin-a", 1);
    const ctx = context.createPluginContext("plugin-a");

    ctx.flags.naturalChildOrdering = "yes";
    expect(ctx.flags.naturalChildOrdering).toBe(false);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));
  });

  it("throws a non-boolean write for a hardened plugin", () => {
    flags.initPluginFlags("plugin-a", 2);
    const ctx = context.createPluginContext("plugin-a");
    expect(() => {
      ctx.flags.naturalChildOrdering = "yes";
    }).toThrow(/Value not valid/);
  });
});

// --- notValid ---------------------------------------------------------------

describe("notValid", () => {
  it("returns null and logs for a version 1 plugin", () => {
    flags.initPluginFlags("plugin-a", 1);
    expect(context.notValid("plugin-a", "code", 5)).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      "[PENPOT PLUGIN] Value not valid: 5. Code: code",
    );
  });

  it("throws for a version 2 plugin", () => {
    flags.initPluginFlags("plugin-a", 2);
    expect(() => context.notValid("plugin-a", "code", 5)).toThrow(
      "[PENPOT PLUGIN] Value not valid: 5. Code: code",
    );
  });

  it("omits the value when there is none", () => {
    flags.initPluginFlags("plugin-a", 1);
    context.notValid("plugin-a", "code");
    expect(console.error).toHaveBeenCalledWith("[PENPOT PLUGIN] Value not valid. Code: code");
  });
});

// --- localStorage proxy -----------------------------------------------------

describe("localStorage proxy", () => {
  it("prefixes every key with the plugin id", () => {
    const storage = stubLocalStorage();
    seedRegistryEntry(["allow:localstorage"]);
    const ctx = context.createPluginContext("plugin-a");

    ctx.localStorage.setItem("alpha", "1");
    expect(storage["penpot-plugins:plugin-a/alpha"]).toBe("1");
    expect(ctx.localStorage.getItem("alpha")).toBe("1");

    ctx.localStorage.removeItem("alpha");
    expect(ctx.localStorage.getItem("alpha")).toBeNull();
  });

  it("lists only the keys of the plugin", () => {
    stubLocalStorage({
      "penpot-plugins:plugin-a/alpha": "1",
      "penpot-plugins:plugin-a/beta": "2",
      "penpot-plugins:plugin-b/gamma": "3",
    });
    seedRegistryEntry(["allow:localstorage"]);
    const ctx = context.createPluginContext("plugin-a");

    expect(ctx.localStorage.getKeys()).toEqual(["alpha", "beta"]);
  });

  it("rejects operations without the permission", () => {
    stubLocalStorage();
    seedRegistryEntry([]);
    const ctx = context.createPluginContext("plugin-a");

    expect(ctx.localStorage.getItem("alpha")).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("allow:localstorage"),
    );
  });

  it("rejects non-string keys", () => {
    stubLocalStorage();
    seedRegistryEntry(["allow:localstorage"]);
    const ctx = context.createPluginContext("plugin-a");

    expect(ctx.localStorage.getItem(5)).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("key must be a string"),
    );
  });
});

// --- context surface --------------------------------------------------------

const FILE_ID = "11111111-1111-1111-1111-111111111111";
const PAGE_ID = "22222222-2222-2222-2222-222222222222";
const SHAPE_ID = "shape-1";

function pageObjects(): WorkspaceObjects {
  return {
    [ZERO_UUID]: { id: ZERO_UUID, type: "frame", name: "Root", shapes: [SHAPE_ID] },
    [SHAPE_ID]: {
      id: SHAPE_ID,
      type: "rect",
      name: "Rect",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      selrect: { x: 0, y: 0, width: 10, height: 10 },
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    },
  };
}

function makeFile(): WorkspaceFile {
  return {
    id: FILE_ID,
    name: "Sample file",
    data: {
      pages: [PAGE_ID],
      "pages-index": {
        [PAGE_ID]: { id: PAGE_ID, name: "Page 1", objects: pageObjects() },
      },
    },
  };
}

function openFile(): WorkspaceFile {
  const file = makeFile();
  store.setWorkspaceState({
    fileId: FILE_ID,
    file,
    pageId: PAGE_ID,
    objects: pageObjects(),
  });
  return file;
}

describe("context surface", () => {
  it("mirrors the config version and carries the plugin id", () => {
    const ctx = context.createPluginContext("plugin-a");
    expect(ctx.$plugin).toBe("plugin-a");
    expect(ctx.version).toBe(config.version ?? "");
  });

  it("answers the workspace reads before a file is open", () => {
    const ctx = context.createPluginContext("plugin-a");
    expect(ctx.root).toBeNull();
    expect(ctx.currentFile).toBeNull();
    expect(ctx.currentPage).toBeNull();
    expect(ctx.selection).toEqual([]);
    expect(ctx.library).toBeNull();
    expect(ctx.fonts).toBeNull();
    expect(ctx.currentUser).toBeNull();
    expect(ctx.activeUsers).toEqual([]);
    expect(ctx.viewport.zoom).toBeNull();
    expect(typeof ctx.history.undoBlockBegin).toBe("function");
  });

  it("mints the root, file, page and selection proxies from the store", () => {
    openFile();
    store.setSelection([SHAPE_ID]);
    const ctx = context.createPluginContext("plugin-a");

    expect(ctx.currentFile?.id).toBe(FILE_ID);
    expect(ctx.currentPage?.id).toBe(PAGE_ID);
    expect(ctx.root?.$id).toBe(ZERO_UUID);
    expect(ctx.selection).toHaveLength(1);
    expect(ctx.selection[0].$id).toBe(SHAPE_ID);
    expect(ctx.selection[0].name).toBe("Rect");
  });

  it("validates the selection setter, then writes the ids", () => {
    flags.initPluginFlags("plugin-a", 1);
    openFile();
    store.setSelection([SHAPE_ID]);
    const ctx = context.createPluginContext("plugin-a");

    ctx.selection = "not-an-array";
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));

    ctx.selection = [ctx.selection[0]];
    expect(store.getWorkspaceState().selection).toEqual([SHAPE_ID]);

    ctx.selection = [];
    expect(store.getWorkspaceState().selection).toEqual([]);
  });

  it("returns null from the creators before a page opens", () => {
    seedRegistryEntry(["content:write"]);
    const ctx = context.createPluginContext("plugin-a");
    expect(ctx.createBoard()).toBeNull();
    expect(ctx.createRectangle()).toBeNull();
    expect(ctx.createEllipse()).toBeNull();
    expect(ctx.createPage()).toBeNull();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps the deferred members as named errors", () => {
    const ctx = context.createPluginContext("plugin-a");
    expect(() => ctx.uploadMediaUrl("name", "url")).toThrow(
      "'uploadMediaUrl' needs the media pipeline",
    );
    expect(() => ctx.replaceColor([], {}, {})).toThrow(/color and library data/);
    expect(() => ctx.group([])).toThrow(/shape structure editor/);
    expect(() => ctx.generateMarkup([])).toThrow(/code generator/);
  });

  it("requires the canvas for a creation once the page opens", () => {
    openFile();
    const ctx = context.createPluginContext("plugin-a");
    expect(() => ctx.createRectangle()).toThrow(/needs the workspace editor/);
  });
});

// --- workspace events -------------------------------------------------------

describe("workspace events", () => {
  it("dispatches file, page and selection changes from the store", () => {
    vi.useFakeTimers();
    const ctx = context.createPluginContext("plugin-a");
    const filechange = vi.fn();
    const pagechange = vi.fn();
    const selectionchange = vi.fn();
    const finish = vi.fn();
    ctx.addListener("filechange", filechange);
    ctx.addListener("pagechange", pagechange);
    ctx.addListener("selectionchange", selectionchange);
    ctx.addListener("finish", finish);

    openFile();
    vi.advanceTimersByTime(10);

    expect(filechange).toHaveBeenCalledTimes(1);
    expect(filechange.mock.calls[0][0].id).toBe(FILE_ID);
    expect(pagechange.mock.calls[0][0].id).toBe(PAGE_ID);
    expect(finish).not.toHaveBeenCalled();

    store.setSelection([SHAPE_ID]);
    vi.advanceTimersByTime(10);
    expect(selectionchange).toHaveBeenLastCalledWith([SHAPE_ID]);

    store.resetWorkspaceState();
    vi.advanceTimersByTime(10);
    expect(finish).toHaveBeenCalledWith(FILE_ID);
  });

  it("dispatches contentsave without arguments", () => {
    vi.useFakeTimers();
    const contentsave = vi.fn();
    context.addPluginListener("plugin-a", "contentsave", contentsave);

    context.notifyPluginContentSaved();
    vi.advanceTimersByTime(10);

    expect(contentsave).toHaveBeenCalledTimes(1);
    expect(contentsave.mock.calls[0]).toEqual([]);
  });

  it("fires shapechange on a new shape object and skips an identical one", () => {
    vi.useFakeTimers();
    openFile();
    const shapechange = vi.fn();
    context.addPluginListener("plugin-a", "shapechange", shapechange, { shapeId: SHAPE_ID });

    // A new objects map with the same shape reference is the CLJS
    // identical? case: no event.
    const objects = store.getWorkspaceState().objects as WorkspaceObjects;
    store.setWorkspaceState({ objects: { ...objects } });
    vi.advanceTimersByTime(10);
    expect(shapechange).not.toHaveBeenCalled();

    const updated = { ...objects[SHAPE_ID], name: "Moved" };
    store.setWorkspaceState({ objects: { ...objects, [SHAPE_ID]: updated } });
    vi.advanceTimersByTime(10);

    expect(shapechange).toHaveBeenCalledTimes(1);
    expect(shapechange.mock.calls[0][0].$id).toBe(SHAPE_ID);
    expect(shapechange.mock.calls[0][0].name).toBe("Moved");
  });

  it("ignores a shapechange listener without a shape id", () => {
    vi.useFakeTimers();
    openFile();
    const shapechange = vi.fn();
    context.addPluginListener("plugin-a", "shapechange", shapechange);

    store.setWorkspaceState({ objects: pageObjects() });
    vi.advanceTimersByTime(10);

    expect(shapechange).not.toHaveBeenCalled();
  });
});

