// Unit tests for the incremental wasm shape upload (F9.5 Task 4, F9.6 T4).
//
// A fake $APP stands in for the compiled renderer: decode_str runs the real
// transit reader, so the recorded payload is the same wire form the backend
// receives; uuid/vec build markers; every wasm write records its call. The
// wasm module itself is not loaded here.

import { describe, expect, it } from "vitest";
import {
  applyShapeStyle,
  cljsShape,
  cljsValue,
  uploadNewShape,
  uploadShapeGeometry,
} from "@/lib/render-wasm/shape-upload";
import { KEY, type RendererApp } from "@/lib/render-wasm/interop";
import { decodeTransit } from "@/lib/transit";

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
    [KEY.uuidParse]: (id: unknown) => `uuid:${String(id)}`,
    [KEY.vec]: (items: readonly unknown[]) => [...items],
    [KEY.setObject]: record("set-object"),
    [KEY.useShape]: record("use-shape"),
    [KEY.setShapeChildren]: record("set-shape-children"),
    [KEY.setShapeFills]: record("set-shape-fills"),
    [KEY.setShapeStrokes]: record("set-shape-strokes"),
    [KEY.setShapeOpacity]: record("set-shape-opacity"),
    [KEY.setShapeHidden]: record("set-shape-hidden"),
    [KEY.setShapeCorners]: record("set-shape-corners"),
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

describe("cljsShape / cljsValue", () => {
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
    const decoded = cljsValue(app, [
      { "fill-color-gradient": { type: "linear" }, "fill-opacity": 1 },
    ]) as Array<Record<string, unknown>>;

    expect(rawPayloads[0]).toContain('"~:type"');
    expect(rawPayloads[0]).toContain('"~:linear"');
    expect(decoded[0]["fill-color-gradient"]).toEqual({ type: "linear" });
  });
});

describe("uploadNewShape", () => {
  it("runs set_object, use_shape(parent), set_shape_children and one render", () => {
    const { app, calls, rawPayloads } = makeFakeApp();
    uploadNewShape(app, rectShape(), [CHILD_A, CHILD_B]);

    expect(calls.map((call) => call.name)).toEqual([
      "set-object",
      "use-shape",
      "set-shape-children",
      "request-render",
    ]);
    expect(calls[1].args).toEqual([`uuid:${FRAME_ID}`]);
    expect(calls[2].args).toEqual([[`uuid:${CHILD_A}`, `uuid:${CHILD_B}`]]);
    // One payload: set_object already wrote fills/strokes, so no extra
    // set_shape_fills / set_shape_strokes call (and no payload per setter).
    expect(rawPayloads).toHaveLength(1);
  });

  it("throws a clear error when a $APP key is missing", () => {
    const { app } = makeFakeApp();
    const broken: RendererApp = { ...app };
    delete broken[KEY.setObject];

    expect(() => uploadNewShape(broken, rectShape(), [])).toThrow(/set_object/);
  });

  it("throws when the shape has no parent-id", () => {
    const { app, calls } = makeFakeApp();
    const orphan = { ...rectShape() };
    delete orphan["parent-id"];

    expect(() => uploadNewShape(app, orphan, [])).toThrow(/parent-id/);
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

describe("applyShapeStyle", () => {
  it("pushes only the provided attributes after use_shape", () => {
    const { app, calls } = makeFakeApp();
    const applied = applyShapeStyle(app, RECT_ID, {
      blocked: false,
      hidden: true,
      opacity: 0.4,
      fills: [{ "fill-color": "#ff0000" }],
      strokes: [{ "stroke-style": "solid" }],
      r1: 1,
      r2: 2,
      r3: 3,
      r4: 4,
    });

    expect(applied).toBe(true);
    expect(calls.map((call) => call.name)).toEqual([
      "use-shape",
      "set-shape-hidden",
      "set-shape-opacity",
      "set-shape-fills",
      "set-shape-strokes",
      "set-shape-corners",
      "request-render",
    ]);
    expect(calls[0].args).toEqual([`uuid:${RECT_ID}`]);
    expect(calls[1].args).toEqual([true]);
    expect(calls[2].args).toEqual([0.4]);
    // The shape id feeds image fetches; thumbnail? stays false.
    expect(calls[3].args[0]).toBe(`uuid:${RECT_ID}`);
    expect(calls[3].args[1]).toEqual([{ "fill-color": "#ff0000" }]);
    expect(calls[3].args[2]).toBe(false);
    expect(calls[4].args[1]).toEqual([{ "stroke-style": "solid" }]);
    // One collection of four numbers, not four arguments.
    expect(calls[5].args).toEqual([[1, 2, 3, 4]]);
  });

  it("still sends an empty fills vector (clearing the fills)", () => {
    const { app, calls } = makeFakeApp();
    expect(applyShapeStyle(app, RECT_ID, { fills: [] })).toBe(true);

    expect(calls.map((call) => call.name)).toEqual([
      "use-shape",
      "set-shape-fills",
      "request-render",
    ]);
    expect(calls[1].args[1]).toEqual([]);
  });

  it("returns false and touches nothing for a blocked-only edit", () => {
    const { app, calls } = makeFakeApp();
    expect(applyShapeStyle(app, RECT_ID, { blocked: true })).toBe(false);
    expect(calls).toEqual([]);
  });
});
