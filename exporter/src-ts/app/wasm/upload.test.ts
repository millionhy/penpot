import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSerializers } from "./enums.js";
import {
  BASE_PROPS_U8_SIZE,
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
} from "./upload.js";
import { getU32 } from "../uuid.js";
import { fakeWasm, record, viewOf, type FakeWasm } from "../../test/fake-wasm.js";
import { testSerializers } from "../../test/enums.js";

const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const parent = "11111111-2222-3333-4444-555555555555";
const child1 = "22222222-3333-4444-5555-666666666666";
const child2 = "33333333-4444-5555-6666-777777777777";

beforeEach(() => {
  setSerializers(testSerializers);
});

afterEach(() => {
  setSerializers(undefined);
});

function shape(overrides: Partial<Shape> = {}): Shape {
  return { id, type: "rect", ...overrides };
}

function buffer(size = 8192): DataView {
  return new DataView(new ArrayBuffer(size));
}

describe("upload", () => {
  it("writes the 104-byte base record", () => {
    const view = buffer();
    const written = shape({
      "parent-id": parent,
      "blend-mode": "multiply",
      "constraints-h": "left",
      "constraints-v": "bottom",
      hidden: true,
      opacity: 0.5,
      rotation: 30,
      transform: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
      selrect: { x1: 1, y1: 2, x2: 3, y2: 4 },
      r1: 5,
      r2: 6,
      r3: 7,
      r4: 8,
    });

    expect(writeShapePayload(view, 0, written)).toBe(BASE_PROPS_U8_SIZE + 4 + 4);

    const expected = getU32(id);
    for (let index = 0; index < 4; index += 1) {
      expect(view.getUint32(index * 4, true)).toBe(expected[index]);
    }
    const expectedParent = getU32(parent);
    for (let index = 0; index < 4; index += 1) {
      expect(view.getUint32(16 + index * 4, true)).toBe(expectedParent[index]);
    }

    expect(view.getUint8(32)).toBe(0);
    expect(view.getUint8(33)).toBe(0x02);
    expect(view.getUint8(34)).toBe(1);
    expect(view.getUint8(35)).toBe(1);
    expect(view.getUint8(36)).toBe(2);
    expect(view.getFloat32(40, true)).toBe(0.5);
    expect(view.getFloat32(44, true)).toBe(30);
    for (let index = 0; index < 6; index += 1) {
      expect(view.getFloat32(48 + index * 4, true)).toBe(index + 1);
    }
    for (let index = 0; index < 4; index += 1) {
      expect(view.getFloat32(72 + index * 4, true)).toBe(index + 1);
    }
    for (let index = 0; index < 4; index += 1) {
      expect(view.getFloat32(88 + index * 4, true)).toBe(index + 5);
    }
  });

  it("defaults the transform to identity and keeps frame clipping", () => {
    const view = buffer();
    writeShapePayload(view, 0, shape({ type: "frame" }));

    expect(view.getUint8(32)).toBe(1);
    expect(view.getUint8(33)).toBe(0x01);
    expect(view.getFloat32(48, true)).toBe(1);
    expect(view.getFloat32(52, true)).toBe(0);
    expect(view.getFloat32(60, true)).toBe(1);
    expect(view.getFloat32(64, true)).toBe(0);
    expect(view.getFloat32(68, true)).toBe(0);

    writeShapePayload(view, 0, shape({ type: "frame", "show-content": true }));
    expect(view.getUint8(33)).toBe(0);
  });

  it("writes the section mask, children, blur, shadows and the group flag", () => {
    const view = buffer();
    const written = shape({
      type: "group",
      "masked-group": true,
      shapes: [child1, child2, "not-a-uuid"],
      blur: { hidden: true, value: 2 },
      "background-blur": { value: 3 },
      shadow: [
        {
          color: { color: "#112233", opacity: 0.5 },
          blur: 4,
          spread: 5,
          "offset-x": 6,
          "offset-y": 7,
          style: "inner-shadow",
          hidden: true,
        },
      ],
    });

    const end = writeShapePayload(view, 0, written);
    expect(end).toBe(payloadByteSize(written));

    const mask = SECTION_CHILDREN | SECTION_BLUR_LAYER | SECTION_BLUR_BG | SECTION_SHADOWS | SECTION_MASKED;
    expect(view.getUint32(BASE_PROPS_U8_SIZE, true)).toBe(mask);

    let at = BASE_PROPS_U8_SIZE + 4;
    expect(view.getUint32(at, true)).toBe(2);
    at += 4;
    const firstChild = getU32(child1);
    for (let index = 0; index < 4; index += 1) {
      expect(view.getUint32(at + index * 4, true)).toBe(firstChild[index]);
    }
    at += 32;

    expect(view.getUint8(at)).toBe(1);
    expect(view.getFloat32(at + 4, true)).toBe(2);
    at += 8;
    expect(view.getUint8(at)).toBe(0);
    expect(view.getFloat32(at + 4, true)).toBe(3);
    at += 8;

    expect(view.getUint32(at, true)).toBe(1);
    at += 4;
    expect(view.getUint32(at, true)).toBe(0x7f112233);
    expect(view.getFloat32(at + 4, true)).toBe(4);
    expect(view.getFloat32(at + 8, true)).toBe(5);
    expect(view.getFloat32(at + 12, true)).toBe(6);
    expect(view.getFloat32(at + 16, true)).toBe(7);
    expect(view.getUint8(at + 20)).toBe(1);
    expect(view.getUint8(at + 21)).toBe(1);
    at += 24;

    expect(view.getUint8(at)).toBe(1);
    expect(end).toBe(at + 4);
  });

  it("adds the bool/grow discriminants and the layout sections", () => {
    const view = buffer();
    const boolShape = shape({ type: "bool", "bool-type": "difference" });
    writeShapePayload(view, 0, boolShape);
    expect(view.getUint32(BASE_PROPS_U8_SIZE, true) & SECTION_BOOL_TYPE).toBe(SECTION_BOOL_TYPE);
    expect(view.getUint8(BASE_PROPS_U8_SIZE + 4 + 4)).toBe(1);

    const text = shape({ type: "text", "grow-type": "auto" });
    writeShapePayload(view, 0, text);
    expect(view.getUint32(BASE_PROPS_U8_SIZE, true) & SECTION_GROW_TYPE).toBe(SECTION_GROW_TYPE);
    expect(view.getUint8(BASE_PROPS_U8_SIZE + 4 + 4)).toBe(1);

    const frame = shape({
      type: "frame",
      layout: "flex",
      "layout-flex-dir": "column",
      "layout-gap": { "row-gap": 8, "column-gap": 9 },
      "layout-padding": { p1: 1, p2: 2, p3: 3, p4: 4 },
      "layout-item-margin": { m1: 5, m2: 6, m3: 7, m4: 8 },
      "layout-item-max-h": 10,
      "layout-item-absolute": true,
      "layout-item-z-index": 3,
    });

    const end = writeShapePayload(view, 0, frame, { includeLayout: true });
    expect(end).toBe(payloadByteSize(frame, { includeLayout: true }));
    const mask = view.getUint32(BASE_PROPS_U8_SIZE, true);
    expect(mask & SECTION_FLEX).toBe(SECTION_FLEX);
    expect(mask & SECTION_LAYOUT_ITEM).toBe(SECTION_LAYOUT_ITEM);

    const flex = BASE_PROPS_U8_SIZE + 4 + 4;
    expect(view.getUint8(flex)).toBe(2);
    expect(view.getFloat32(flex + 8, true)).toBe(8);
    expect(view.getFloat32(flex + 12, true)).toBe(9);
    expect(view.getFloat32(flex + 16, true)).toBe(1);
    expect(view.getFloat32(flex + 28, true)).toBe(4);

    const item = flex + 32;
    expect(view.getFloat32(item, true)).toBe(5);
    expect(view.getFloat32(item + 12, true)).toBe(8);
    expect(view.getUint8(item + 18)).toBe(0x11);
    expect(view.getFloat32(item + 20, true)).toBe(10);
    expect(view.getInt32(item + 36, true)).toBe(3);
  });

  it("inlines the fills and visible strokes only on request", () => {
    const view = buffer();
    const written = shape({
      fills: [{ "fill-color": "#112233", "fill-opacity": 0.5 }],
      strokes: [
        { "stroke-color": "#ff0000", "stroke-width": 2 },
        { hidden: true },
      ],
    });

    const end = writeShapePayload(view, 0, written, { includeFillsStrokes: true });
    expect(end).toBe(payloadByteSize(written, { includeFillsStrokes: true }));
    const mask = view.getUint32(BASE_PROPS_U8_SIZE, true);
    expect(mask & SECTION_FILLS).toBe(SECTION_FILLS);
    expect(mask & SECTION_STROKES).toBe(SECTION_STROKES);

    const fills = BASE_PROPS_U8_SIZE + 4 + 4;
    expect(view.getUint8(fills)).toBe(1);
    expect(view.getUint8(fills + 4)).toBe(0x00);
    expect(view.getUint32(fills + 8, true)).toBe(0x7f112233);

    const strokes = fills + 4 + 160;
    expect(view.getUint32(strokes, true)).toBe(1);
    expect(view.getFloat32(strokes + 4, true)).toBe(2);
    expect(view.getUint32(strokes + 4 + 36 + 4, true)).toBe(0xffff0000);

    // Without the option the sections are absent and the payload is shorter.
    const plain = shape({ fills: [{ "fill-color": "#112233" }], strokes: [{}] });
    expect(payloadByteSize(plain)).toBe(BASE_PROPS_U8_SIZE + 4 + 4);
  });

  it("prefixes every record with its payload length", () => {
    const written = shape({ type: "group", shapes: [child1] });
    const record = encodeShapeRecord(written);
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);

    expect(record.byteLength).toBe(4 + payloadByteSize(written));
    expect(view.getUint32(0, true)).toBe(record.byteLength - 4);
    expect(view.getUint32(4 + BASE_PROPS_U8_SIZE, true) & SECTION_CHILDREN).toBe(SECTION_CHILDREN);
  });

  it("frames the batch with a count and uploads it in one call", () => {
    const target: FakeWasm = fakeWasm();
    record(target, "_set_shapes_batch");

    const first = shape();
    const second = shape({ id: parent, type: "frame" });
    flushShapesBatch([first, second], {}, target);

    expect(target.allocs).toEqual([256]);
    expect(target.calls.map((call) => call.name)).toEqual(["_set_shapes_batch"]);
    expect(target.frees).toBe(0);

    const view = viewOf(target);
    expect(view.getUint32(256, true)).toBe(2);
    const firstLength = view.getUint32(260, true);
    expect(firstLength).toBe(payloadByteSize(first));
    const secondLengthAt = 260 + 4 + firstLength;
    expect(view.getUint32(secondLengthAt, true)).toBe(payloadByteSize(second));
    expect(secondLengthAt + 4 + payloadByteSize(second)).toBe(
      256 + 4 + 4 + firstLength + 4 + payloadByteSize(second),
    );
  });
});
