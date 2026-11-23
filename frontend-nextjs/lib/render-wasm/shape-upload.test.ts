// Unit tests for the incremental engine upload (F9.5 Task 4, F9.6 T4).
//
// The engine owns the wasm layout; this module only decides which records
// travel and in what order. The tests replace `setObject` with a recorder, so
// they pin the protocol the canvas relies on:
// - a new shape goes first, then its parent record, then one render;
// - a geometry push rewrites every record and requests one render;
// - an undo/redo batch writes the parents before the shapes;
// - the host attrs run once per uploaded record.

import { beforeEach, describe, expect, it, vi } from "vitest";

const engine = vi.hoisted(() => ({
  setObject: vi.fn(),
}));

vi.mock("@/lib/render-wasm/engine", () => ({
  setObject: engine.setObject,
}));

import {
  applyShapeStyle,
  attrsWriteStyle,
  uploadChangedShapes,
  uploadNewShape,
  uploadShapeGeometry,
} from "@/lib/render-wasm/shape-upload";
import type { WorkspaceApp } from "@/lib/render-wasm/workspace-app";
import type { UpdateFileChange } from "@/lib/transit";

const RECT_ID = "00000000-0000-0000-0000-0000000000c1";
const FRAME_ID = "00000000-0000-0000-0000-0000000000c2";
const CHILD_A = "00000000-0000-0000-0000-0000000000c3";
const CHILD_B = "00000000-0000-0000-0000-0000000000c4";
const PAGE = "00000000-0000-0000-0000-0000000000d3";

interface FakeApp {
  app: WorkspaceApp;
  renders: string[];
  hostCalls: string[];
}

function makeApp(): FakeApp {
  const renders: string[] = [];
  const hostCalls: string[] = [];
  const app = {
    module: { name: "fake-module" },
    loop: {
      requestRender: (reason: string): boolean => {
        renders.push(reason);
        return true;
      },
    },
    host: {
      hostAttrs: (shape: { id: string }): void => {
        hostCalls.push(shape.id);
      },
    },
  };
  return { app: app as unknown as WorkspaceApp, renders, hostCalls };
}

function rectShape(): Record<string, unknown> {
  return {
    id: RECT_ID,
    type: "rect",
    name: "Rectangle",
    "parent-id": FRAME_ID,
    "frame-id": FRAME_ID,
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    selrect: { x: 0, y: 0, width: 100, height: 50, x1: 0, y1: 0, x2: 100, y2: 50 },
    fills: [{ "fill-color": "#B1B2B5", "fill-opacity": 1 }],
    strokes: [],
    r1: 0,
    r2: 0,
    r3: 0,
    r4: 0,
  };
}

function uploadedIds(): string[] {
  return engine.setObject.mock.calls.map(
    (call) => (call[1] as { id: string }).id,
  );
}

beforeEach(() => {
  engine.setObject.mockReset();
  // Mirror the engine contract: setObject hands the prepared record to the
  // host before the next call.
  engine.setObject.mockImplementation(
    (
      _module: unknown,
      shape: { id: string },
      options?: { onShape?: (shape: { id: string }) => void },
    ) => {
      options?.onShape?.(shape);
    },
  );
});

describe("uploadNewShape", () => {
  it("runs new shape, parent record and one render in that order", () => {
    const { app, renders, hostCalls } = makeApp();
    const parent = { id: FRAME_ID, type: "frame", shapes: [CHILD_A, CHILD_B] };

    uploadNewShape(app, rectShape(), parent);

    expect(uploadedIds()).toEqual([RECT_ID, FRAME_ID]);
    expect(hostCalls).toEqual([RECT_ID, FRAME_ID]);
    expect(renders).toEqual(["upload-new-shape"]);
    expect(engine.setObject.mock.calls[0][0]).toBe(app.module);
    expect(engine.setObject.mock.calls[0][2]).toEqual({
      onShape: expect.any(Function),
    });
  });

  it("skips the parent write when the parent has no record", () => {
    const { app, renders } = makeApp();

    uploadNewShape(app, rectShape(), undefined);

    expect(uploadedIds()).toEqual([RECT_ID]);
    expect(renders).toEqual(["upload-new-shape"]);
  });

  it("throws when the shape has no parent-id", () => {
    const { app } = makeApp();
    const orphan = { ...rectShape() };
    delete orphan["parent-id"];

    expect(() => uploadNewShape(app, orphan, undefined)).toThrow(/parent-id/);
    expect(engine.setObject).not.toHaveBeenCalled();
  });
});

describe("uploadShapeGeometry", () => {
  it("rewrites every record and requests one render after the loop", () => {
    const { app, renders, hostCalls } = makeApp();

    uploadShapeGeometry(app, [rectShape(), { ...rectShape(), id: CHILD_A }]);

    expect(uploadedIds()).toEqual([RECT_ID, CHILD_A]);
    expect(hostCalls).toEqual([RECT_ID, CHILD_A]);
    expect(renders).toEqual(["upload-shape-geometry"]);
  });

  it("still requests one render for an empty list", () => {
    const { app, renders } = makeApp();

    uploadShapeGeometry(app, []);

    expect(engine.setObject).not.toHaveBeenCalled();
    expect(renders).toEqual(["upload-shape-geometry"]);
  });
});

describe("uploadChangedShapes", () => {
  const ROOT = "00000000-0000-0000-0000-0000000000d0";
  const FRAME = "00000000-0000-0000-0000-0000000000d1";
  const FRAME_TWO = "00000000-0000-0000-0000-0000000000d2";

  function frame(id: string, children: string[]): Record<string, unknown> {
    return { id, type: "frame", "parent-id": ROOT, "frame-id": id, shapes: children };
  }

  function beforeModel(): Record<string, Record<string, unknown>> {
    return {
      [ROOT]: frame(ROOT, [FRAME]),
      [FRAME]: frame(FRAME, [RECT_ID]),
      [FRAME_TWO]: frame(FRAME_TWO, []),
      [RECT_ID]: { ...rectShape(), "parent-id": FRAME, "frame-id": FRAME },
    };
  }

  it("rewrites a modified shape without touching children", () => {
    const { app, renders } = makeApp();
    const before = beforeModel();
    const after = { ...before, [RECT_ID]: { ...before[RECT_ID], x: 10 } };
    const changes: UpdateFileChange[] = [
      {
        type: "mod-obj",
        "page-id": PAGE,
        id: RECT_ID,
        operations: [{ type: "set", attr: "x", val: 10 }],
      },
    ];

    uploadChangedShapes(app, before, after, changes);

    expect(uploadedIds()).toEqual([RECT_ID]);
    expect(renders).toEqual(["upload-changed-shapes"]);
  });

  it("writes the parent before an added shape", () => {
    const { app } = makeApp();
    const before = beforeModel();
    const added = { ...rectShape(), id: CHILD_A, "parent-id": FRAME, "frame-id": FRAME };
    const after = {
      ...before,
      [CHILD_A]: added,
      [FRAME]: { ...before[FRAME], shapes: [RECT_ID, CHILD_A] },
    };
    const changes: UpdateFileChange[] = [
      {
        type: "add-obj",
        id: CHILD_A,
        obj: added,
        "page-id": PAGE,
        "frame-id": FRAME,
        "parent-id": FRAME,
      },
    ];

    uploadChangedShapes(app, before, after, changes);

    expect(uploadedIds()).toEqual([FRAME, CHILD_A]);
  });

  it("drops a deleted shape through the parent record only", () => {
    const { app } = makeApp();
    const before = beforeModel();
    const after = {
      ...before,
      [FRAME]: { ...before[FRAME], shapes: [] },
    };
    delete (after as Record<string, unknown>)[RECT_ID];
    const changes: UpdateFileChange[] = [
      { type: "del-obj", "page-id": PAGE, id: RECT_ID },
    ];

    uploadChangedShapes(app, before, after, changes);

    expect(uploadedIds()).toEqual([FRAME]);
  });

  it("writes the new parent, the old parent and the moved shape", () => {
    const { app } = makeApp();
    const before = beforeModel();
    const after = {
      ...before,
      [FRAME]: { ...before[FRAME], shapes: [] },
      [FRAME_TWO]: { ...before[FRAME_TWO], shapes: [RECT_ID] },
      [RECT_ID]: { ...before[RECT_ID], "parent-id": FRAME_TWO, "frame-id": FRAME_TWO },
    };
    const changes: UpdateFileChange[] = [
      { type: "mov-objects", "page-id": PAGE, "parent-id": FRAME_TWO, shapes: [RECT_ID] },
    ];

    uploadChangedShapes(app, before, after, changes);

    expect(uploadedIds()).toEqual([FRAME_TWO, FRAME, RECT_ID]);
  });

  it("still requests one render when a change targets missing shapes", () => {
    const { app, renders } = makeApp();

    uploadChangedShapes(app, {}, {}, [
      { type: "del-obj", "page-id": PAGE, id: RECT_ID },
    ]);

    expect(engine.setObject).not.toHaveBeenCalled();
    expect(renders).toEqual(["upload-changed-shapes"]);
  });
});

describe("applyShapeStyle", () => {
  it("re-sends the whole record for a style edit", () => {
    const { app, renders } = makeApp();
    const shape = { ...rectShape(), hidden: true, opacity: 0.4 };

    const applied = applyShapeStyle(app, shape, {
      blocked: false,
      hidden: true,
      opacity: 0.4,
    });

    expect(applied).toBe(true);
    expect(uploadedIds()).toEqual([RECT_ID]);
    expect(renders).toEqual(["apply-shape-style"]);
  });

  it("re-sends the record for a fills edit, including a cleared list", () => {
    const { app, renders } = makeApp();

    expect(applyShapeStyle(app, rectShape(), { fills: [] })).toBe(true);

    expect(uploadedIds()).toEqual([RECT_ID]);
    expect(renders).toEqual(["apply-shape-style"]);
  });

  it("returns false and touches nothing for a blocked-only edit", () => {
    const { app, renders } = makeApp();

    expect(applyShapeStyle(app, rectShape(), { blocked: true })).toBe(false);

    expect(engine.setObject).not.toHaveBeenCalled();
    expect(renders).toEqual([]);
  });

  it("re-sends the record for a shadow or a blur removal", () => {
    const { app } = makeApp();

    expect(applyShapeStyle(app, rectShape(), { shadow: null })).toBe(true);
    expect(applyShapeStyle(app, rectShape(), { blur: null })).toBe(true);

    expect(uploadedIds()).toEqual([RECT_ID, RECT_ID]);
  });

  it("re-sends the record for layout, layout item, constraint and fixed-scroll edits", () => {
    const { app } = makeApp();

    expect(applyShapeStyle(app, rectShape(), { layout: "flex" })).toBe(true);
    expect(
      applyShapeStyle(app, rectShape(), { "layout-item-h-sizing": "fill" }),
    ).toBe(true);
    expect(applyShapeStyle(app, rectShape(), { "constraints-h": "left" })).toBe(
      true,
    );
    expect(applyShapeStyle(app, rectShape(), { "fixed-scroll": true })).toBe(true);

    expect(uploadedIds()).toEqual([RECT_ID, RECT_ID, RECT_ID, RECT_ID]);
  });

  it("re-sends the record when a text commit rewrites content", () => {
    const { app } = makeApp();

    expect(attrsWriteStyle({ content: { type: "root" } })).toBe(true);
    expect(applyShapeStyle(app, rectShape(), { content: { type: "root" } })).toBe(
      true,
    );
    expect(uploadedIds()).toEqual([RECT_ID]);
  });

  it("classifies editor-only attributes", () => {
    expect(attrsWriteStyle({ blocked: true })).toBe(false);
    expect(attrsWriteStyle({ "layout-item-z-index": 2 })).toBe(true);
    expect(attrsWriteStyle({ "constraints-v": null })).toBe(true);
  });
});
