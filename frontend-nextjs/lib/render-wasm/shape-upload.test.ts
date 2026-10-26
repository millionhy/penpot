// Unit tests for the incremental wasm shape upload (F9.5 Task 4, F9.6 T4).
//
// A fake $APP stands in for the compiled renderer: decode_str runs the real
// transit reader, so the recorded payload is the same wire form the backend
// receives; every wasm write records its call. Only set_object and
// request_render are stubbed: this build exports no other shape setter on
// $APP (see lib/render-wasm/shape-upload.ts). The wasm module itself is not
// loaded here.

import { describe, expect, it } from "vitest";
import {
  applyShapeStyle,
  attrsWriteStyle,
  cljsShape,
  uploadChangedShapes,
  uploadNewShape,
  uploadShapeGeometry,
} from "@/lib/render-wasm/shape-upload";
import { KEY, type RendererApp } from "@/lib/render-wasm/interop";
import { decodeTransit, type UpdateFileChange } from "@/lib/transit";

const RECT_ID = "00000000-0000-0000-0000-0000000000c1";
const FRAME_ID = "00000000-0000-0000-0000-0000000000c2";
const CHILD_A = "00000000-0000-0000-0000-0000000000c3";
const CHILD_B = "00000000-0000-0000-0000-0000000000c4";

interface RecordedCall {
  name: string;
  args: unknown[];
}

function makeFakeApp() {
  const calls: RecordedCall[] = [];
  const rawPayloads: string[] = [];
  const record =
    (name: string) =>
    (...args: unknown[]): void => {
      calls.push({ name, args });
    };

  const app: RendererApp = {
    [KEY.decodeStr]: (raw: unknown) => {
      rawPayloads.push(String(raw));
      return decodeTransit(String(raw));
    },
    [KEY.setObject]: record("set-object"),
    [KEY.requestRender]: record("request-render"),
  };

  return { app, calls, rawPayloads };
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
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ],
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    "transform-inverse": { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    fills: [{ "fill-color": "#B1B2B5", "fill-opacity": 1 }],
    strokes: [],
    r1: 0,
    r2: 0,
    r3: 0,
    r4: 0,
  };
}

describe("cljsShape", () => {
  it("decodes a shape into the keyword-keyed wire payload", () => {
    const { app, rawPayloads } = makeFakeApp();
    const decoded = cljsShape(app, rectShape()) as Record<string, unknown>;

    expect(rawPayloads).toHaveLength(1);
    expect(rawPayloads[0]).toContain('"~#shape"');
    expect(rawPayloads[0]).toContain('"~:parent-id"');
    expect(rawPayloads[0]).toContain('"~:fill-color"');
    expect(decoded.type).toBe("rect");
    expect(decoded["parent-id"]).toBe(FRAME_ID);
    expect(decoded["frame-id"]).toBe(FRAME_ID);
    expect(decoded.fills).toEqual([{ "fill-color": "#B1B2B5", "fill-opacity": 1 }]);
  });

  it("decodes fills with their enum values", () => {
    const { app, rawPayloads } = makeFakeApp();
    const decoded = cljsShape(app, {
      ...rectShape(),
      fills: [{ "fill-color-gradient": { type: "linear" }, "fill-opacity": 1 }],
    }) as Record<string, unknown>;

    expect(rawPayloads[0]).toContain('"~:type"');
    expect(rawPayloads[0]).toContain('"~:linear"');
    expect(decoded.fills).toEqual([
      { "fill-color-gradient": { type: "linear" }, "fill-opacity": 1 },
    ]);
  });
});

describe("uploadNewShape", () => {
  it("runs set_object(new), set_object(parent) and one render", () => {
    const { app, calls, rawPayloads } = makeFakeApp();
    const parent = { id: FRAME_ID, type: "frame", shapes: [CHILD_A, CHILD_B] };
    uploadNewShape(app, rectShape(), parent);

    expect(calls.map((call) => call.name)).toEqual([
      "set-object",
      "set-object",
      "request-render",
    ]);
    // The new shape first, then the parent record with its children list.
    expect(rawPayloads).toHaveLength(2);
    expect(rawPayloads[0]).toContain('"~#shape"');
    expect(rawPayloads[0]).toContain(`"~u${RECT_ID}"`);
    expect(rawPayloads[1]).toContain(`"~u${FRAME_ID}"`);
    expect(rawPayloads[1]).toContain(`"~u${CHILD_A}"`);
    expect(rawPayloads[1]).toContain(`"~u${CHILD_B}"`);
  });

  it("skips the parent write when the parent has no record", () => {
    const { app, calls } = makeFakeApp();
    uploadNewShape(app, rectShape(), undefined);

    expect(calls.map((call) => call.name)).toEqual(["set-object", "request-render"]);
  });

  it("throws a clear error when a $APP key is missing", () => {
    const { app } = makeFakeApp();
    const broken: RendererApp = { ...app };
    delete broken[KEY.setObject];

    expect(() => uploadNewShape(broken, rectShape(), undefined)).toThrow(/set_object/);
  });

  it("throws when the shape has no parent-id", () => {
    const { app, calls } = makeFakeApp();
    const orphan = { ...rectShape() };
    delete orphan["parent-id"];

    expect(() => uploadNewShape(app, orphan, undefined)).toThrow(/parent-id/);
    expect(calls).toEqual([]);
  });
});

describe("uploadShapeGeometry", () => {
  it("runs set_object per shape and one render after the loop", () => {
    const { app, calls, rawPayloads } = makeFakeApp();
    uploadShapeGeometry(app, [rectShape(), { ...rectShape(), id: CHILD_A }]);

    expect(calls.map((call) => call.name)).toEqual([
      "set-object",
      "set-object",
      "request-render",
    ]);
    expect(rawPayloads).toHaveLength(2);
    expect(rawPayloads[0]).toContain('"~#shape"');
  });

  it("still requests one render for an empty list", () => {
    const { app, calls } = makeFakeApp();
    uploadShapeGeometry(app, []);

    expect(calls.map((call) => call.name)).toEqual(["request-render"]);
  });

  it("propagates a wasm failure to the caller", () => {
    const { app } = makeFakeApp();
    const broken: RendererApp = { ...app };
    delete broken[KEY.setObject];

    expect(() => uploadShapeGeometry(broken, [rectShape()])).toThrow(/set_object/);
  });
});

describe("uploadChangedShapes", () => {
  const ROOT = "00000000-0000-0000-0000-0000000000d0";
  const FRAME = "00000000-0000-0000-0000-0000000000d1";
  const FRAME_TWO = "00000000-0000-0000-0000-0000000000d2";
  const PAGE = "00000000-0000-0000-0000-0000000000d3";

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
    const { app, calls } = makeFakeApp();
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

    expect(calls.map((call) => call.name)).toEqual(["set-object", "request-render"]);
  });

  it("attaches an added shape through its parent record", () => {
    const { app, calls } = makeFakeApp();
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

    // The parent record first (its children list carries the new shape),
    // then the added shape itself.
    expect(calls.map((call) => call.name)).toEqual([
      "set-object",
      "set-object",
      "request-render",
    ]);
  });

  it("drops a deleted shape from the parent record and does not rewrite it", () => {
    const { app, calls } = makeFakeApp();
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

    expect(calls.map((call) => call.name)).toEqual(["set-object", "request-render"]);
  });

  it("updates both parents of a re-parent commit", () => {
    const { app, calls } = makeFakeApp();
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

    // The new parent comes first (the change), then the old one (before),
    // then the moved shape.
    expect(calls.map((call) => call.name)).toEqual([
      "set-object",
      "set-object",
      "set-object",
      "request-render",
    ]);
  });

  it("still requests one render when a change targets missing shapes", () => {
    const { app, calls } = makeFakeApp();
    uploadChangedShapes(app, {}, {}, [
      { type: "del-obj", "page-id": PAGE, id: RECT_ID },
    ]);

    expect(calls.map((call) => call.name)).toEqual(["request-render"]);
  });
});

describe("applyShapeStyle", () => {
  it("re-sends the whole record for a style edit", () => {
    const { app, calls, rawPayloads } = makeFakeApp();
    const shape = { ...rectShape(), hidden: true, opacity: 0.4 };
    const applied = applyShapeStyle(app, shape, {
      blocked: false,
      hidden: true,
      opacity: 0.4,
    });

    expect(applied).toBe(true);
    // One set_object carries base props (hidden/opacity) and the host attrs
    // (fills/strokes); the granular setters are not exported on $APP.
    expect(calls.map((call) => call.name)).toEqual(["set-object", "request-render"]);
    expect(rawPayloads).toHaveLength(1);
    expect(rawPayloads[0]).toContain('"~#shape"');
    expect(rawPayloads[0]).toContain(`"~u${RECT_ID}"`);
  });

  it("re-sends the record for a fills edit, including a cleared list", () => {
    const { app, calls } = makeFakeApp();
    expect(applyShapeStyle(app, rectShape(), { fills: [] })).toBe(true);

    expect(calls.map((call) => call.name)).toEqual(["set-object", "request-render"]);
  });

  it("returns false and touches nothing for a blocked-only edit", () => {
    const { app, calls } = makeFakeApp();
    expect(applyShapeStyle(app, rectShape(), { blocked: true })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("re-sends the record for a shadow edit with its enum keyword", () => {
    const { app, calls, rawPayloads } = makeFakeApp();
    const shadow = {
      id: "00000000-0000-0000-0000-0000000000e1",
      style: "drop-shadow",
      "offset-x": 4,
      "offset-y": 4,
      blur: 4,
      spread: 0,
      hidden: false,
      color: { color: "#000000", opacity: 0.2 },
    };
    const shape = { ...rectShape(), shadow: [shadow] };

    expect(applyShapeStyle(app, shape, { shadow: [shadow] })).toBe(true);

    expect(calls.map((call) => call.name)).toEqual(["set-object", "request-render"]);
    // The style travels as a keyword: a plain string fails the backend enum.
    expect(rawPayloads[0]).toContain('"~:drop-shadow"');
  });

  it("re-sends the record when a shadow or a blur is removed", () => {
    const { app, calls, rawPayloads } = makeFakeApp();

    expect(applyShapeStyle(app, rectShape(), { shadow: null })).toBe(true);
    expect(applyShapeStyle(app, rectShape(), { blur: null })).toBe(true);

    // A nil removal still rewrites the record: set_object then drops the
    // effect from the renderer state.
    expect(calls.map((call) => call.name)).toEqual([
      "set-object",
      "request-render",
      "set-object",
      "request-render",
    ]);
    expect(rawPayloads[0]).not.toContain('"~:shadow"');
    expect(rawPayloads[1]).not.toContain('"~:blur"');
  });

  it("re-sends the record for a layout, a layout item or a constraint edit", () => {
    const { app, calls } = makeFakeApp();

    expect(applyShapeStyle(app, rectShape(), { layout: "flex" })).toBe(true);
    expect(
      applyShapeStyle(app, rectShape(), { "layout-item-h-sizing": "fill" }),
    ).toBe(true);
    expect(applyShapeStyle(app, rectShape(), { "constraints-h": "left" })).toBe(
      true,
    );
    expect(applyShapeStyle(app, rectShape(), { "fixed-scroll": true })).toBe(true);

    expect(calls.map((call) => call.name)).toEqual([
      "set-object",
      "request-render",
      "set-object",
      "request-render",
      "set-object",
      "request-render",
      "set-object",
      "request-render",
    ]);
  });

  it("never rewrites the record for an editor-only attribute", () => {
    expect(attrsWriteStyle({ blocked: true })).toBe(false);
    expect(attrsWriteStyle({ "layout-item-z-index": 2 })).toBe(true);
    expect(attrsWriteStyle({ "constraints-v": null })).toBe(true);
  });
});
