// Unit tests for the plugin shape proxy (F7.4, app.plugins.shape).
//
// The proxy reads the live page model through lib/workspace-bridge (falling
// back to the module store) and writes through the canvas bridge commands.
// Every test installs a recording bridge and asserts the exact command a
// write sends, so the CLJS commit shape (attribute map / geometry target) is
// pinned. The read side covers the values the CLJS getters compute
// (format/shape-type, the points bounds, the parent origin).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceFile, WorkspaceObjects } from "@/lib/workspace";
import type { WorkspaceBridge } from "@/lib/workspace-bridge";

let bridgeModule: typeof import("@/lib/workspace-bridge");
let shape: typeof import("@/lib/plugin-shape");
let flags: typeof import("@/lib/plugin-flags");
let plugins: typeof import("@/lib/plugins");
let store: typeof import("@/lib/workspace-store");

const FILE_ID = "11111111-1111-1111-1111-111111111111";
const PAGE_ID = "22222222-2222-2222-2222-222222222222";
const OTHER_PAGE_ID = "33333333-3333-3333-3333-333333333333";
const RECT_ID = "shape-rect";
const GROUP_ID = "shape-group";
const CHILD_ID = "shape-child";

beforeEach(async () => {
  vi.resetModules();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  bridgeModule = await import("@/lib/workspace-bridge");
  shape = await import("@/lib/plugin-shape");
  flags = await import("@/lib/plugin-flags");
  plugins = await import("@/lib/plugins");
  store = await import("@/lib/workspace-store");
  store.resetWorkspaceState();
  plugins.initRegistryFromProfile(null);
  flags.initPluginFlags("plugin-a", 1);
});

afterEach(() => {
  bridgeModule.registerWorkspaceBridge(null);
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
    [ZERO_UUID]: {
      id: ZERO_UUID,
      type: "frame",
      name: "Root",
      shapes: [RECT_ID, GROUP_ID],
      ...box(0, 0, 500, 500),
    },
    [RECT_ID]: {
      id: RECT_ID,
      type: "rect",
      name: "Rect",
      "parent-id": ZERO_UUID,
      rotation: 15,
      fills: [{ "fill-color": "#ff0000", "fill-opacity": 1 }],
      strokes: [{ "stroke-color": "#000000", "stroke-width": 2 }],
      ...box(10, 20, 100, 50),
    },
    [GROUP_ID]: {
      id: GROUP_ID,
      type: "group",
      name: "Group",
      "parent-id": ZERO_UUID,
      shapes: [CHILD_ID],
      ...box(40, 40, 200, 200),
    },
    [CHILD_ID]: {
      id: CHILD_ID,
      type: "rect",
      name: "Child",
      "parent-id": GROUP_ID,
      ...box(50, 60, 10, 10),
    },
  };
}

function makeFile(objects: WorkspaceObjects = pageObjects()): WorkspaceFile {
  return {
    id: FILE_ID,
    name: "Sample file",
    revn: 7,
    data: {
      pages: [PAGE_ID, OTHER_PAGE_ID],
      "pages-index": {
        [PAGE_ID]: { id: PAGE_ID, name: "Page 1", objects },
        [OTHER_PAGE_ID]: { id: OTHER_PAGE_ID, name: "Page 2", objects: {} },
      },
    },
  };
}

function openPage(permissions: string[] = ["content:read", "content:write"]): void {
  seedPermissions(permissions);
  store.setWorkspaceState({
    fileId: FILE_ID,
    file: makeFile(),
    pageId: PAGE_ID,
    objects: pageObjects(),
  });
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
    createPage: vi.fn(async () => "created-page"),
    renamePage: vi.fn(async () => true),
    deletePage: vi.fn(async () => true),
  };
  bridgeModule.registerWorkspaceBridge(bridge as unknown as WorkspaceBridge);
  return bridge as RecordingBridge;
}

function proxyOf(id: string): Record<string, unknown> {
  return shape.createShapeProxy("plugin-a", PAGE_ID, id) as Record<string, unknown>;
}

// --- reads ------------------------------------------------------------------

describe("shape proxy reads", () => {
  it("maps the stored type to the plugin name", () => {
    openPage();
    expect(proxyOf(RECT_ID).type).toBe("rectangle");
    expect(proxyOf(GROUP_ID).type).toBe("group");
    expect(proxyOf(ZERO_UUID).type).toBe("board");
    expect(shape.pluginShapeType("circle")).toBe("ellipse");
    expect(shape.pluginShapeType("bool")).toBe("boolean");
    expect(shape.pluginShapeType(undefined)).toBe("");
  });

  it("answers the identity and flag reads from the live shape", () => {
    openPage();
    const rect = proxyOf(RECT_ID);
    expect(rect.id).toBe(RECT_ID);
    expect(rect.name).toBe("Rect");
    expect(rect.blocked).toBe(false);
    expect(rect.hidden).toBe(false);
    expect(rect.visible).toBe(true);
    expect(rect.proportionLock).toBe(false);
    expect(rect.blendMode).toBe("normal");
  });

  it("computes the geometry from the points and the selrect", () => {
    openPage();
    const rect = proxyOf(RECT_ID);
    expect(rect.x).toBe(10);
    expect(rect.y).toBe(20);
    expect(rect.width).toBe(100);
    expect(rect.height).toBe(50);
    expect(rect.bounds).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(rect.center).toEqual({ x: 60, y: 45 });
    expect(rect.rotation).toBe(15);
    expect(rect.flipX).toBe(false);
    expect(rect.flipY).toBe(false);
  });

  it("answers the parent-relative position against the parent origin", () => {
    openPage();
    const child = proxyOf(CHILD_ID);
    expect(child.parentX).toBe(10);
    expect(child.parentY).toBe(20);
    expect(child.boardX).toBe(10);
    expect(child.boardY).toBe(20);
  });

  it("walks the tree: parent, parentIndex and getChildren", () => {
    openPage();
    const group = proxyOf(GROUP_ID);
    expect((group.parent as Record<string, unknown>).$id).toBe(ZERO_UUID);
    expect(group.parentIndex).toBe(1);

    const children = (group.getChildren as () => Record<string, unknown>[])();
    expect(children.map((child) => child.$id)).toEqual([CHILD_ID]);

    // A leaf is not a container: the CLJS answers the invalid-value report.
    expect((proxyOf(RECT_ID).getChildren as () => unknown)()).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));
  });

  it("answers no shape once the page switches", () => {
    openPage();
    const rect = proxyOf(RECT_ID);
    store.setWorkspaceState({ pageId: OTHER_PAGE_ID, objects: {} });
    expect(rect.name).toBeUndefined();
    expect(rect.x).toBeUndefined();
    expect(rect.rotation).toBe(0);
  });

  it("exposes the fills as live camelCase elements", () => {
    openPage();
    const bridge = installBridge();
    const fills = proxyOf(RECT_ID).fills as Record<string, unknown>[];
    expect(fills[0].fillColor).toBe("#ff0000");
    expect(fills[0].fillOpacity).toBe(1);

    fills[0].fillColor = "#00ff00";
    expect(bridge.updateShapeAttrs).toHaveBeenCalledWith(RECT_ID, {
      fills: [{ "fill-color": "#00ff00", "fill-opacity": 1 }],
    });
  });
});

// --- writes -----------------------------------------------------------------

describe("shape proxy writes", () => {
  it("trims the name and commits the attribute", () => {
    openPage();
    const bridge = installBridge();
    proxyOf(RECT_ID).name = "  New name  ";
    expect(bridge.updateShapeAttrs).toHaveBeenCalledWith(RECT_ID, { name: "New name" });
  });

  it("reports an empty name and skips the commit", () => {
    openPage();
    const bridge = installBridge();
    proxyOf(RECT_ID).name = "   ";
    expect(bridge.updateShapeAttrs).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));
  });

  it("writes the visibility flags inverted like the CLJS", () => {
    openPage();
    const bridge = installBridge();
    const rect = proxyOf(RECT_ID);
    rect.visible = false;
    expect(bridge.updateShapeAttrs).toHaveBeenCalledWith(RECT_ID, { hidden: true });
    rect.hidden = true;
    expect(bridge.updateShapeAttrs).toHaveBeenLastCalledWith(RECT_ID, { hidden: true });
  });

  it("validates opacity and the blend mode", () => {
    openPage();
    const bridge = installBridge();
    const rect = proxyOf(RECT_ID);

    rect.opacity = 1.5;
    expect(bridge.updateShapeAttrs).not.toHaveBeenCalled();
    rect.opacity = 0.5;
    expect(bridge.updateShapeAttrs).toHaveBeenLastCalledWith(RECT_ID, { opacity: 0.5 });

    rect.blendMode = "sepia";
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));
    rect.blendMode = "multiply";
    expect(bridge.updateShapeAttrs).toHaveBeenLastCalledWith(RECT_ID, {
      "blend-mode": "multiply",
    });
  });

  it("writes the four corners of borderRadius", () => {
    openPage();
    const bridge = installBridge();
    proxyOf(RECT_ID).borderRadius = 8;
    expect(bridge.updateShapeAttrs).toHaveBeenCalledWith(RECT_ID, {
      r1: 8,
      r2: 8,
      r3: 8,
      r4: 8,
    });

    proxyOf(RECT_ID).borderRadiusTopLeft = 3;
    expect(bridge.updateShapeAttrs).toHaveBeenLastCalledWith(RECT_ID, { r1: 3 });
  });

  it("stores a camelCase fills list in the kebab-case form", () => {
    openPage();
    const bridge = installBridge();
    proxyOf(RECT_ID).fills = [{ fillColor: "#00ff00", fillOpacity: 0.5 }];
    expect(bridge.updateShapeAttrs).toHaveBeenCalledWith(RECT_ID, {
      fills: [{ "fill-color": "#00ff00", "fill-opacity": 0.5 }],
    });
  });

  it("reports a fills list that is not a record list", () => {
    openPage();
    const bridge = installBridge();
    proxyOf(RECT_ID).fills = [1, 2];
    expect(bridge.updateShapeAttrs).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));
  });
});

// --- geometry ---------------------------------------------------------------

describe("shape proxy geometry", () => {
  it("commits the absolute position and the size", () => {
    openPage();
    const bridge = installBridge();
    const rect = proxyOf(RECT_ID);

    rect.x = 15;
    expect(bridge.updateShapeGeometry).toHaveBeenLastCalledWith(RECT_ID, { x: 15 });

    (rect.resize as (width: unknown, height: unknown) => void)(200, 80);
    expect(bridge.updateShapeGeometry).toHaveBeenLastCalledWith(RECT_ID, {
      width: 200,
      height: 80,
    });

    (rect.resize as (width: unknown, height: unknown) => void)(0, 80);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));
  });

  it("turns the rotation setter into an absolute angle and rotate into a delta", () => {
    openPage();
    const bridge = installBridge();
    const rect = proxyOf(RECT_ID);

    rect.rotation = 30;
    expect(bridge.updateShapeGeometry).toHaveBeenLastCalledWith(RECT_ID, { rotation: 45 });

    (rect.rotate as (angle: unknown) => void)(15);
    expect(bridge.updateShapeGeometry).toHaveBeenLastCalledWith(RECT_ID, { rotation: 30 });
  });

  it("accepts only the shape center as a custom rotate pivot", () => {
    openPage();
    const bridge = installBridge();
    const rect = proxyOf(RECT_ID);

    (rect.rotate as (angle: unknown, center?: unknown) => void)(90, { x: 60, y: 45 });
    expect(bridge.updateShapeGeometry).toHaveBeenLastCalledWith(RECT_ID, { rotation: 105 });

    (rect.rotate as (angle: unknown, center?: unknown) => void)(90, { x: 0, y: 0 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Value not valid"));
    expect(bridge.updateShapeGeometry).toHaveBeenCalledTimes(1);
  });

  it("writes the parent-relative position as an absolute one", () => {
    openPage();
    const bridge = installBridge();
    proxyOf(CHILD_ID).parentX = 5;
    expect(bridge.updateShapeGeometry).toHaveBeenCalledWith(CHILD_ID, { x: 45 });
  });
});

// --- gates and deferred members ---------------------------------------------

describe("shape proxy write gate", () => {
  it("refuses the write without content:write", () => {
    openPage(["content:read"]);
    const bridge = installBridge();
    proxyOf(RECT_ID).name = "New";
    expect(bridge.updateShapeAttrs).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("content:write"));
  });

  it("refuses the write on a page that is no longer open", () => {
    openPage();
    const bridge = installBridge();
    const rect = proxyOf(RECT_ID);
    store.setWorkspaceState({ pageId: OTHER_PAGE_ID, objects: {} });

    rect.name = "New";
    expect(bridge.updateShapeAttrs).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("not currently active"));
  });
});

describe("shape proxy deferred members", () => {
  it("names the slice each structure method waits for", () => {
    openPage();
    const rect = proxyOf(RECT_ID);
    for (const method of [
      "remove",
      "clone",
      "bringForward",
      "sendBackward",
      "bringToFront",
      "sendToBack",
    ]) {
      expect(() => (rect[method] as () => unknown)()).toThrow(/shape structure editor/);
    }
    expect(() => (rect["appendChild"] as (child: unknown) => unknown)(null)).toThrow(
      /shape structure editor/,
    );
    expect(() => (rect["getPluginData"] as (key: unknown) => unknown)("key")).toThrow(
      /shape structure editor/,
    );
  });
});

// --- helpers ----------------------------------------------------------------

describe("shape proxy helpers", () => {
  it("marks the proxies it mints", () => {
    openPage();
    const proxy = proxyOf(RECT_ID);
    expect(shape.isShapeProxy(proxy)).toBe(true);
    expect(shape.isShapeProxy({})).toBe(false);
    expect(shape.shapeProxyId(proxy)).toBe(RECT_ID);
    expect(shape.shapeProxyPage(proxy)).toBe(PAGE_ID);
    expect(shape.shapeProxyId({})).toBeNull();
  });
});
