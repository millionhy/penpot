// Unit tests for the plugin workspace proxies (F7.4): viewport, history,
// page, file and the context members that mint them.
//
// Each proxy reads the module store on every access and writes through the
// canvas bridge; the tests install a recording bridge and pin the command
// each write sends. The page switch runs through lib/workspace-navigation, so
// the opener the shell registers is exercised here too.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceFile, WorkspaceObjects } from "@/lib/workspace";
import type { WorkspaceBridge } from "@/lib/workspace-bridge";

let bridgeModule: typeof import("@/lib/workspace-bridge");
let navigation: typeof import("@/lib/workspace-navigation");
let flags: typeof import("@/lib/plugin-flags");
let plugins: typeof import("@/lib/plugins");
let store: typeof import("@/lib/workspace-store");
let workspace: typeof import("@/lib/plugin-workspace");

const FILE_ID = "11111111-1111-1111-1111-111111111111";
const PAGE_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_PAGE_ID = "33333333-3333-3333-3333-333333333333";
const RECT_ID = "shape-rect";
const FRAME_ID = "shape-frame";

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  bridgeModule = await import("@/lib/workspace-bridge");
  navigation = await import("@/lib/workspace-navigation");
  flags = await import("@/lib/plugin-flags");
  plugins = await import("@/lib/plugins");
  store = await import("@/lib/workspace-store");
  workspace = await import("@/lib/plugin-workspace");
  store.resetWorkspaceState();
  plugins.initRegistryFromProfile(null);
  flags.initPluginFlags("plugin-a", 1);
});

afterEach(() => {
  bridgeModule.registerWorkspaceBridge(null);
  navigation.registerWorkspacePageOpener(null);
  vi.restoreAllMocks();
});

// --- fixtures ---------------------------------------------------------------

function box(x: number, y: number, width: number, height: number) {
  return {
    selrect: { x, y, width, height },
    points: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
  };
}

function pageObjects(): WorkspaceObjects {
  return {
    [ZERO_UUID]: { id: ZERO_UUID, type: "frame", name: "Root", shapes: [RECT_ID], ...box(0, 0, 500, 500) },
    [RECT_ID]: {
      id: RECT_ID,
      type: "rect",
      name: "Rect",
      "parent-id": ZERO_UUID,
      ...box(10, 20, 100, 50),
    },
    [FRAME_ID]: { id: FRAME_ID, type: "frame", name: "Board", ...box(0, 0, 300, 300) },
  };
}

function makeFile(): WorkspaceFile {
  return {
    id: FILE_ID,
    name: "Sample file",
    revn: 7,
    data: {
      pages: [PAGE_ID, OTHER_PAGE_ID],
      "pages-index": {
        [PAGE_ID]: {
          id: PAGE_ID,
          name: "Page 1",
          background: "#ffffff",
          flows: {
            "flow-1": { id: "flow-1", name: "Flow", "starting-frame": FRAME_ID },
          },
          guides: {
            "guide-1": { id: "guide-1", axis: "x", position: 10 },
            "guide-2": { id: "guide-2", axis: "y", position: 20, "frame-id": FRAME_ID },
          },
          objects: pageObjects(),
        },
        [OTHER_PAGE_ID]: { id: OTHER_PAGE_ID, name: "Page 2", objects: {} },
      },
    },
  };
}

function seedPermissions(permissions: string[]): void {
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

function openFile(permissions: string[] = ["content:read", "content:write"]): void {
  seedPermissions(permissions);
  store.setWorkspaceState({
    fileId: FILE_ID,
    file: makeFile(),
    pageId: PAGE_ID,
    objects: pageObjects(),
    zoom: 2,
    vbox: { x: 100, y: 200, width: 400, height: 300 },
  });
}

type RecordingBridge = { [K in keyof WorkspaceBridge]: ReturnType<typeof vi.fn> };

function installBridge(): RecordingBridge {
  const bridge = {
    objects: vi.fn(() => null),
    createShape: vi.fn(async () => true),
    updateShapeAttrs: vi.fn(async () => true),
    updateShapesAttrs: vi.fn(async () => true),
    updateShapeGeometry: vi.fn(async () => true),
    alignObjects: vi.fn(async () => true),
    distributeObjects: vi.fn(async () => true),
    undo: vi.fn(),
    redo: vi.fn(),
    beginUndoBlock: vi.fn(),
    endUndoBlock: vi.fn(),
    viewport: vi.fn(() => null),
    setZoom: vi.fn(),
    setCenter: vi.fn(),
    zoomReset: vi.fn(),
    zoomToFitAll: vi.fn(),
    zoomIntoView: vi.fn(),
    createPage: vi.fn(async (id?: string) => id ?? "created-page"),
    renamePage: vi.fn(async () => true),
    deletePage: vi.fn(async () => true),
  };
  bridgeModule.registerWorkspaceBridge(bridge as unknown as WorkspaceBridge);
  return bridge as RecordingBridge;
}

// --- viewport ---------------------------------------------------------------

describe("viewport proxy", () => {
  it("reads the center, the zoom and the bounds from the store", () => {
    openFile();
    const viewport = workspace.createViewportProxy("plugin-a");
    expect(viewport.zoom).toBe(2);
    expect(viewport.center).toEqual({ x: 300, y: 350 });
    expect(viewport.bounds).toEqual({ x: 100, y: 200, width: 400, height: 300 });
  });

  it("answers null before the canvas reports a viewport", () => {
    const viewport = workspace.createViewportProxy("plugin-a");
    expect(viewport.zoom).toBeNull();
    expect(viewport.center).toBeNull();
    expect(viewport.bounds).toBeNull();
  });

  it("writes the zoom and the center through the canvas", () => {
    openFile();
    const bridge = installBridge();
    const viewport = workspace.createViewportProxy("plugin-a");

    viewport.zoom = 3;
    expect(bridge.setZoom).toHaveBeenCalledWith(3);

    viewport.center = { x: 10, y: 20 };
    expect(bridge.setCenter).toHaveBeenCalledWith({ x: 10, y: 20 });

    viewport.zoomReset();
    expect(bridge.zoomReset).toHaveBeenCalled();
    viewport.zoomToFitAll();
    expect(bridge.zoomToFitAll).toHaveBeenCalled();
  });

  it("validates the zoom and the center", () => {
    openFile();
    const bridge = installBridge();
    const viewport = workspace.createViewportProxy("plugin-a");

    viewport.zoom = Number.NaN;
    expect(bridge.setZoom).not.toHaveBeenCalled();
    viewport.center = { x: 10, y: "20" } as unknown as { x: number; y: number };
    expect(bridge.setCenter).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));
  });

  it("maps the shape proxies of zoomIntoView to their ids", () => {
    openFile();
    const bridge = installBridge();
    const viewport = workspace.createViewportProxy("plugin-a");
    const page = workspace.createPageProxy("plugin-a", FILE_ID, PAGE_ID);
    const rect = page.getShapeById(RECT_ID);

    viewport.zoomIntoView([rect]);
    expect(bridge.zoomIntoView).toHaveBeenCalledWith([RECT_ID]);

    viewport.zoomIntoView([{}]);
    expect(bridge.zoomIntoView).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("valid shapes"));
  });

  it("refuses a write before the editor mounts", () => {
    openFile();
    const viewport = workspace.createViewportProxy("plugin-a");
    expect(() => {
      viewport.zoomReset();
    }).toThrow(/needs the workspace editor/);
  });
});

// --- history ----------------------------------------------------------------

describe("history proxy", () => {
  it("pairs a begin with its finish", () => {
    openFile();
    const bridge = installBridge();
    const history = workspace.createHistoryProxy("plugin-a");

    const block = history.undoBlockBegin();
    expect(typeof block).toBe("symbol");
    expect(bridge.beginUndoBlock).toHaveBeenCalledTimes(1);

    history.undoBlockFinish(block);
    expect(bridge.endUndoBlock).toHaveBeenCalledTimes(1);

    // A second finish of the same block is the invalid-value report.
    history.undoBlockFinish(block);
    expect(bridge.endUndoBlock).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));
  });

  it("ignores a block symbol it did not open", () => {
    openFile();
    const bridge = installBridge();
    const history = workspace.createHistoryProxy("plugin-a");

    history.undoBlockFinish(Symbol("foreign"));
    expect(bridge.endUndoBlock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));
  });

  it("refuses the blocks without content:write", () => {
    openFile(["content:read"]);
    const bridge = installBridge();
    const history = workspace.createHistoryProxy("plugin-a");

    history.undoBlockBegin();
    expect(bridge.beginUndoBlock).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("content:write"));
  });
});

// --- page -------------------------------------------------------------------

describe("page proxy", () => {
  it("reads the page name, background, flows and page-level guides", () => {
    openFile();
    const page = workspace.createPageProxy("plugin-a", FILE_ID, PAGE_ID);
    expect(page.id).toBe(PAGE_ID);
    expect(page.name).toBe("Page 1");
    expect(page.background).toBe("#ffffff");
    expect(page.flows).toEqual([
      { id: "flow-1", name: "Flow", startingBoard: FRAME_ID },
    ]);
    // A guide of a board belongs to that board, not to the page.
    expect(page.rulerGuides).toEqual([
      { id: "guide-1", orientation: "vertical", position: 10, boardId: null },
    ]);
  });

  it("falls back to the default canvas color", () => {
    openFile();
    const page = workspace.createPageProxy("plugin-a", FILE_ID, OTHER_PAGE_ID);
    expect(page.background).toBe("#E8E9EA");
    expect(page.flows).toEqual([]);
  });

  it("renames the page through the canvas", () => {
    openFile();
    const bridge = installBridge();
    const page = workspace.createPageProxy("plugin-a", FILE_ID, PAGE_ID);

    page.name = "  New name  ";
    expect(bridge.renamePage).toHaveBeenCalledWith(PAGE_ID, "New name");

    page.name = "";
    expect(bridge.renamePage).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));
  });

  it("refuses a rename without content:write", () => {
    openFile(["content:read"]);
    const bridge = installBridge();
    const page = workspace.createPageProxy("plugin-a", FILE_ID, PAGE_ID);

    page.name = "New name";
    expect(bridge.renamePage).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("content:write"));
  });

  it("mints shape proxies for getRoot and getShapeById", () => {
    openFile();
    const page = workspace.createPageProxy("plugin-a", FILE_ID, PAGE_ID);

    expect((page.getRoot() as Record<string, unknown>).$id).toBe(ZERO_UUID);
    expect((page.root as Record<string, unknown>).$id).toBe(ZERO_UUID);

    const rect = page.getShapeById(RECT_ID) as Record<string, unknown>;
    expect(rect.$id).toBe(RECT_ID);
    expect(rect.name).toBe("Rect");

    expect(page.getShapeById("missing")).toBeNull();
    expect(page.getShapeById(5)).toBeNull();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));
  });

  it("filters findShapes by name, name-like and type", () => {
    openFile();
    const page = workspace.createPageProxy("plugin-a", FILE_ID, PAGE_ID);

    expect(page.findShapes({ name: "rect" })).toHaveLength(1);
    expect(page.findShapes({ "name-like": "rec" })).toHaveLength(1);
    expect(page.findShapes({ type: "frame" })).toHaveLength(2);
    // The criteria names are the plugin-facing ones, like the CLJS.
    expect(page.findShapes({ type: "board" })).toHaveLength(0);
    expect(page.findShapes(undefined)).toHaveLength(3);
  });

  it("opens the page through the registered opener", () => {
    openFile();
    const opener = vi.fn();
    navigation.registerWorkspacePageOpener(opener);
    const page = workspace.createPageProxy("plugin-a", FILE_ID, OTHER_PAGE_ID);

    void page.openPage();
    expect(opener).toHaveBeenCalledWith(OTHER_PAGE_ID);
    expect(store.getWorkspaceState().pageId).toBe(PAGE_ID);
  });

  it("refuses to open a page the file does not carry", () => {
    openFile();
    const opener = vi.fn();
    navigation.registerWorkspacePageOpener(opener);
    const page = workspace.createPageProxy("plugin-a", FILE_ID, "missing-page");

    void page.openPage();
    expect(opener).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Page not found"));
  });

  it("refuses openPage without content:read", () => {
    openFile(["content:write"]);
    const opener = vi.fn();
    navigation.registerWorkspacePageOpener(opener);
    const page = workspace.createPageProxy("plugin-a", FILE_ID, OTHER_PAGE_ID);

    void page.openPage();
    expect(opener).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("content:read"));
  });

  it("removes a page through the canvas and keeps the last one", () => {
    openFile();
    const bridge = installBridge();
    const page = workspace.createPageProxy("plugin-a", FILE_ID, OTHER_PAGE_ID);
    page.remove();
    expect(bridge.deletePage).toHaveBeenCalledWith(OTHER_PAGE_ID);

    // The file now holds a single page: the CLJS refuses the removal.
    const file = makeFile();
    file.data.pages = [PAGE_ID];
    store.setWorkspaceState({ file });
    const only = workspace.createPageProxy("plugin-a", FILE_ID, PAGE_ID);
    only.remove();
    expect(bridge.deletePage).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("Cannot remove the last page"),
    );
  });

  it("names the slice the flow and comment members wait for", () => {
    openFile();
    const page = workspace.createPageProxy("plugin-a", FILE_ID, PAGE_ID);
    expect(() => page.createFlow()).toThrow(/workspace data layer/);
    expect(() => page.addRulerGuide()).toThrow(/workspace data layer/);
    expect(() => page.findCommentThreads()).toThrow(/workspace data layer/);
  });

  it("marks the page proxies it mints", () => {
    const page = workspace.createPageProxy("plugin-a", FILE_ID, PAGE_ID);
    expect(workspace.isPageProxy(page)).toBe(true);
    expect(workspace.isPageProxy({})).toBe(false);
    expect(workspace.pageProxyId(page)).toBe(PAGE_ID);
    expect(workspace.pageProxyId({})).toBeNull();
  });
});

// --- file -------------------------------------------------------------------

describe("file proxy", () => {
  it("reads the file header and mints the page proxies in order", () => {
    openFile();
    const file = workspace.createFileProxy("plugin-a", FILE_ID);
    expect(file.id).toBe(FILE_ID);
    expect(file.name).toBe("Sample file");
    expect(file.revn).toBe(7);

    const pages = file.getPages() as { id: string }[];
    expect(pages.map((page) => page.id)).toEqual([PAGE_ID, OTHER_PAGE_ID]);
    expect(file.pages).toHaveLength(2);
  });

  it("creates a page from a minted id and answers the proxy at once", () => {
    openFile();
    const bridge = installBridge();
    const file = workspace.createFileProxy("plugin-a", FILE_ID);

    const page = file.createPage() as { id: string };
    expect(typeof page.id).toBe("string");
    expect(bridge.createPage).toHaveBeenCalledWith(page.id);
    expect(workspace.isPageProxy(page)).toBe(true);
  });

  it("refuses createPage without content:write", () => {
    openFile(["content:read"]);
    const bridge = installBridge();
    const file = workspace.createFileProxy("plugin-a", FILE_ID);

    expect(file.createPage()).toBeNull();
    expect(bridge.createPage).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("content:write"));
  });

  it("names the slice the version and export members wait for", () => {
    openFile();
    const file = workspace.createFileProxy("plugin-a", FILE_ID);
    expect(() => file.validate()).toThrow(/workspace data layer/);
    expect(() => file.export()).toThrow(/workspace data layer/);
    expect(() => file.findVersions()).toThrow(/workspace data layer/);
  });
});

// --- context members --------------------------------------------------------

describe("context members", () => {
  it("answers null before a file opens", () => {
    expect(workspace.currentFileProxy("plugin-a")).toBeNull();
    expect(workspace.currentPageProxy("plugin-a")).toBeNull();
    expect(workspace.rootShapeProxy("plugin-a")).toBeNull();
    expect(workspace.selectedShapeProxies("plugin-a")).toEqual([]);
  });

  it("mints the root and the selection proxies from the store", () => {
    openFile();
    store.setSelection([RECT_ID, FRAME_ID]);

    expect(workspace.currentFileProxy("plugin-a")?.id).toBe(FILE_ID);
    expect(workspace.currentPageProxy("plugin-a")?.id).toBe(PAGE_ID);
    expect((workspace.rootShapeProxy("plugin-a") as Record<string, unknown>).$id).toBe(ZERO_UUID);

    const selection = workspace.selectedShapeProxies("plugin-a") as Record<string, unknown>[];
    expect(selection.map((proxy) => proxy.$id)).toEqual([RECT_ID, FRAME_ID]);
  });

  it("writes the selection as an ordered unique id list", () => {
    openFile();
    const page = workspace.createPageProxy("plugin-a", FILE_ID, PAGE_ID);
    const rect = page.getShapeById(RECT_ID);

    expect(workspace.selectShapeProxies([rect, rect])).toBe(true);
    expect(store.getWorkspaceState().selection).toEqual([RECT_ID]);

    expect(workspace.selectShapeProxies([])).toBe(true);
    expect(store.getWorkspaceState().selection).toEqual([]);

    expect(workspace.selectShapeProxies([{}])).toBe(false);
  });
});
