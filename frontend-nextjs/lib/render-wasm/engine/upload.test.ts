import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markContextInitialized,
  resetModule,
  setModule,
  type RenderWasmModule,
} from "./module";
import {
  BASE_PROPS_U8_SIZE,
  FLAG_CLIP_CONTENT,
  FLAG_HIDDEN,
  SECTION_BLUR_BG,
  SECTION_BLUR_LAYER,
  SECTION_BOOL_TYPE,
  SECTION_CHILDREN,
  SECTION_FILLS,
  SECTION_FLEX,
  SECTION_GROW_TYPE,
  SECTION_LAYOUT_ITEM,
  SECTION_MASKED,
  SECTION_SHADOWS,
  SECTION_STROKES,
  encodeShapeRecord,
  flushShapesBatch,
  payloadByteSize,
  writeShapePayload,
  type Shape,
} from "./upload";
import { FILL_U8_SIZE, STROKE_HEADER_U8_SIZE } from "./fills";

const ID = "12345678-9abc-def0-1122-334455667788";
const PARENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CHILD = "11111111-2222-3333-4444-555555555555";

interface Recorded {
  name: string;
  args: unknown[];
}

function makeModule(recorded: Recorded[], heapSize = 1 << 16): RenderWasmModule {
  const heap = new Uint8Array(heapSize);
  let next = 8;
  const record = (name: string) =>
    (...args: unknown[]) => {
      recorded.push({ name, args });
      return 0;
    };

  return {
    HEAPU8: heap,
    HEAPU32: new Uint32Array(heap.buffer),
    HEAP32: new Int32Array(heap.buffer),
    HEAPF32: new Float32Array(heap.buffer),
    UTF8ToString: () => "",
    _alloc_bytes: (size: number) => {
      recorded.push({ name: "_alloc_bytes", args: [size] });
      const at = next;
      next += (size + 7) & ~3;
      return at;
    },
    _set_shapes_batch: record("_set_shapes_batch"),
  };
}

function rect(overrides: Partial<Shape> = {}): Shape {
  return { id: ID, type: "rect", ...overrides };
}

let recorded: Recorded[];
let module: RenderWasmModule;

beforeEach(() => {
  resetModule();
  recorded = [];
  module = makeModule(recorded);
  setModule(module);
  markContextInitialized();
});

afterEach(() => {
  resetModule();
});

function recordView(record: Uint8Array): DataView {
  return new DataView(record.buffer, record.byteOffset, record.byteLength);
}

describe("encodeShapeRecord", () => {
  it("prefixes the payload length and keeps writer and estimator in step", () => {
    const shape = rect();
    const record = encodeShapeRecord(shape);
    const view = recordView(record);

    expect(record.byteLength).toBe(4 + payloadByteSize(shape));
    expect(view.getUint32(0, true)).toBe(record.byteLength - 4);
  });

  it("writes the base props at their fixed offsets", () => {
    const record = encodeShapeRecord(
      rect({
        "parent-id": PARENT,
        type: "frame",
        "show-content": false,
        hidden: true,
        opacity: 0.5,
        rotation: 45,
        "blend-mode": "multiply",
        "constraints-h": "right",
        "constraints-v": "scale",
        transform: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
        selrect: { x1: 1, y1: 2, x2: 3, y2: 4 },
        r1: 1,
        r2: 2,
        r3: 3,
        r4: 4,
      }),
    );
    const view = recordView(record);
    const base = 4;

    expect(view.getUint32(base, true)).toBe(0x12345678);
    expect(view.getUint32(base + 16, true)).toBe(0xaaaaaaaa);
    expect(view.getUint32(base + 20, true)).toBe(0xbbbbcccc);
    expect(view.getUint8(base + 32)).toBe(0); // frame
    expect(view.getUint8(base + 33)).toBe(FLAG_CLIP_CONTENT | FLAG_HIDDEN);
    expect(view.getUint8(base + 34)).toBe(24); // multiply
    expect(view.getUint8(base + 35)).toBe(2); // right
    expect(view.getUint8(base + 36)).toBe(5); // scale
    expect(view.getFloat32(base + 40, true)).toBe(0.5);
    expect(view.getFloat32(base + 44, true)).toBe(45);
    expect(view.getFloat32(base + 48, true)).toBe(1);
    expect(view.getFloat32(base + 68, true)).toBe(6);
    expect(view.getFloat32(base + 72, true)).toBe(1);
    expect(view.getFloat32(base + 84, true)).toBe(4);
    expect(view.getFloat32(base + 88, true)).toBe(1);
    expect(view.getFloat32(base + 100, true)).toBe(4);
  });

  it("defaults a missing parent to the zero uuid and a missing transform to identity", () => {
    const view = recordView(encodeShapeRecord(rect()));
    const base = 4;
    expect(view.getUint32(base + 16, true)).toBe(0);
    expect(view.getUint8(base + 32)).toBe(3); // rect
    expect(view.getUint8(base + 33)).toBe(0); // no clip, not hidden
    expect(view.getUint8(base + 34)).toBe(3); // blend mode normal
    expect(view.getUint8(base + 35)).toBe(0);
    expect(view.getUint8(base + 36)).toBe(0);
    expect(view.getFloat32(base + 48, true)).toBe(1);
    expect(view.getFloat32(base + 60, true)).toBe(1);
  });

  it("writes the children list after the mask", () => {
    const view = recordView(
      encodeShapeRecord(rect({ type: "group", shapes: [CHILD, null, "nope"] })),
    );
    const maskAt = 4 + BASE_PROPS_U8_SIZE;
    expect(view.getUint32(maskAt, true)).toBe(SECTION_CHILDREN | SECTION_MASKED);
    expect(view.getUint32(maskAt + 4, true)).toBe(1);
    expect(view.getUint32(maskAt + 8, true)).toBe(0x11111111);
  });

  it("marks every optional section it writes", () => {
    const view = recordView(
      encodeShapeRecord(
        rect({
          type: "text",
          blur: { hidden: false, value: 2 },
          "background-blur": { value: 1 },
          shadow: [{ style: "drop-shadow" }],
          "grow-type": "auto-height",
          fills: [{ "fill-color": "#000000" }],
          strokes: [{ "stroke-color": "#000000" }],
        }),
        { includeFillsStrokes: true },
      ),
    );
    const mask = view.getUint32(4 + BASE_PROPS_U8_SIZE, true);
    expect(mask & SECTION_BLUR_LAYER).toBe(SECTION_BLUR_LAYER);
    expect(mask & SECTION_BLUR_BG).toBe(SECTION_BLUR_BG);
    expect(mask & SECTION_SHADOWS).toBe(SECTION_SHADOWS);
    expect(mask & SECTION_GROW_TYPE).toBe(SECTION_GROW_TYPE);
    expect(mask & SECTION_FILLS).toBe(SECTION_FILLS);
    expect(mask & SECTION_STROKES).toBe(SECTION_STROKES);
    expect(mask & SECTION_BOOL_TYPE).toBe(0);
  });

  it("writes flex before the layout item, and only when layout is included", () => {
    const frame = rect({ type: "frame", layout: "flex", "layout-gap": { "row-gap": 4 } });
    const withLayout = payloadByteSize(frame, { includeLayout: true });
    const withoutLayout = payloadByteSize(frame);
    expect(withLayout - withoutLayout).toBe(32 + 40);

    const view = recordView(encodeShapeRecord(frame, { includeLayout: true }));
    const mask = view.getUint32(4 + BASE_PROPS_U8_SIZE, true);
    expect(mask & SECTION_FLEX).toBe(SECTION_FLEX);
    expect(mask & SECTION_LAYOUT_ITEM).toBe(SECTION_LAYOUT_ITEM);

    const without = recordView(encodeShapeRecord(frame));
    expect(without.getUint32(4 + BASE_PROPS_U8_SIZE, true) & SECTION_LAYOUT_ITEM).toBe(0);
  });

  it("drops hidden strokes", () => {
    const hidden = rect({ strokes: [{ hidden: true, "stroke-color": "#000000" }] });
    const view = recordView(encodeShapeRecord(hidden, { includeFillsStrokes: true }));
    const strokesAt = 4 + BASE_PROPS_U8_SIZE + 4 + 4 + 4;
    expect(view.getUint32(strokesAt, true)).toBe(0);
  });

  it("counts fills and strokes into the payload size", () => {
    const shape = rect({
      fills: [{ "fill-color": "#000000" }, { "fill-color": "#ffffff" }],
      strokes: [{ "stroke-color": "#000000" }, { hidden: true }],
    });
    expect(payloadByteSize(shape, { includeFillsStrokes: true })).toBe(
      payloadByteSize(shape) +
        4 +
        2 * FILL_U8_SIZE +
        4 +
        1 * (STROKE_HEADER_U8_SIZE + FILL_U8_SIZE),
    );
  });

  it("keeps the writer and the estimator in step for every section combo", () => {
    const shapes: Shape[] = [
      rect(),
      rect({ type: "group", shapes: [CHILD], "masked-group": true }),
      rect({ type: "bool", "bool-type": "difference", blur: { value: 1 } }),
      rect({ type: "text", "grow-type": "auto-width", shadow: [{}, {}] }),
      rect({ type: "frame", layout: "flex", fills: [{ "fill-color": "#000000" }] }),
      rect({ strokes: [{ "stroke-color": "#000000" }, { hidden: true }] }),
    ];
    for (const shape of shapes) {
      for (const options of [{}, { includeLayout: true }, { includeFillsStrokes: true }]) {
        const buffer = new ArrayBuffer(4 + payloadByteSize(shape, options));
        const end = writeShapePayload(new DataView(buffer), 4, shape, options);
        expect(end).toBe(buffer.byteLength);
      }
    }
  });

  it("can write a payload at an arbitrary offset", () => {
    const shape = rect({ type: "circle" });
    const buffer = new ArrayBuffer(payloadByteSize(shape) + 16);
    const view = new DataView(buffer);
    const end = writeShapePayload(view, 12, shape);
    expect(end).toBe(12 + payloadByteSize(shape));
    expect(view.getUint8(12 + 32)).toBe(6); // circle
  });
});

describe("flushShapesBatch", () => {
  it("writes the count, then the records, and lets the renderer keep the buffer", () => {
    const records = [encodeShapeRecord(rect()), encodeShapeRecord({ id: CHILD, type: "circle" })];
    flushShapesBatch(module, [rect(), { id: CHILD, type: "circle" }]);

    expect(recorded.map((e) => e.name)).toEqual(["_alloc_bytes", "_set_shapes_batch"]);
    expect(recorded[0].args).toEqual([4 + records[0].byteLength + records[1].byteLength]);
    expect(new DataView(module.HEAPU8.buffer).getUint32(8, true)).toBe(2);
    expect(new DataView(module.HEAPU8.buffer).getUint32(12, true)).toBe(records[0].byteLength - 4);
  });

  it("does nothing for an empty list", () => {
    flushShapesBatch(module, []);
    expect(recorded).toEqual([]);
  });
});