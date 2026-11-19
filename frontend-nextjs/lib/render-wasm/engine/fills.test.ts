import { describe, expect, it } from "vitest";
import {
  FILL_U8_SIZE,
  coerce,
  getByteSize,
  getImageIds,
  getStrokeImageIds,
  type Stroke,
  writeFill,
  writeFills,
  writeStrokeFill,
} from "./fills";
import { EngineError } from "./errors";

const ID = "12345678-9abc-def0-1122-334455667788";

function viewOf(size = 1024): { view: DataView; bytes: Uint8Array } {
  const buffer = new ArrayBuffer(size);
  return { view: new DataView(buffer), bytes: new Uint8Array(buffer) };
}

describe("coerce and getByteSize", () => {
  it("caps the list at MAX_FILLS", () => {
    const fills = Array.from({ length: 12 }, () => ({ "fill-color": "#000000" }));
    expect(coerce(fills)).toHaveLength(8);
    expect(coerce(null)).toEqual([]);
  });

  it("is a four-byte header plus one fixed record per fill", () => {
    expect(getByteSize([])).toBe(4);
    expect(getByteSize([{ "fill-color": "#000000" }])).toBe(4 + FILL_U8_SIZE);
  });
});

describe("writeFill", () => {
  it("writes a solid fill as type 0 and an ARGB word", () => {
    const { view, bytes } = viewOf();
    writeFill(view, 8, { "fill-color": "#ff0000", "fill-opacity": 0.5 });
    expect(bytes[8]).toBe(0);
    expect(new DataView(bytes.buffer).getUint32(12, true)).toBe(0x7fff0000);
  });

  it("writes a linear gradient with its stops", () => {
    const { view, bytes } = viewOf();
    writeFill(view, 0, {
      "fill-color-gradient": {
        type: "linear",
        "start-x": 0,
        "start-y": 0,
        "end-x": 10,
        "end-y": 20,
        stops: [
          { color: "#000000", opacity: 1, offset: 0 },
          { color: "#ffffff", opacity: 0.5, offset: 1 },
        ],
      },
    });
    expect(bytes[0]).toBe(0x01);
    expect(view.getFloat32(4, true)).toBe(0);
    expect(view.getFloat32(12, true)).toBe(10);
    expect(bytes[28]).toBe(2); // stop count
    expect(view.getUint32(32, true)).toBe(0xff000000);
    expect(view.getUint32(40, true)).toBe(0x7fffffff);
  });

  it("writes a radial gradient as type 2", () => {
    const { view, bytes } = viewOf();
    writeFill(view, 0, { "fill-color-gradient": { type: "radial" } });
    expect(bytes[0]).toBe(0x02);
  });

  it("writes an image fill with the uuid quartet and its flags", () => {
    const { view, bytes } = viewOf();
    writeFill(view, 0, {
      "fill-image": {
        id: ID,
        width: 40,
        height: 30,
        "keep-aspect-ratio": true,
        transform: { x: 1, y: 2, width: 3, height: 4 },
      },
    });
    expect(bytes[0]).toBe(0x03);
    expect(view.getUint32(4, true)).toBe(0x12345678);
    expect(view.getUint32(16, true)).toBe(0x55667788);
    expect(bytes[20]).toBe(0xff);
    expect(bytes[21]).toBe(0x03); // keep aspect + transform
    expect(view.getInt32(24, true)).toBe(40);
    expect(view.getFloat32(44, true)).toBe(4);
  });

  it("rejects a fill with no paint", () => {
    const { view } = viewOf();
    expect(() => writeFill(view, 0, {})).toThrow(EngineError);
  });
});

describe("writeFills", () => {
  it("writes the count header and advances by the fixed record size", () => {
    const { view, bytes } = viewOf();
    const end = writeFills(view, 0, [
      { "fill-color": "#000000" },
      { "fill-color": "#ffffff" },
    ]);
    expect(bytes[0]).toBe(2);
    expect(end).toBe(4 + 2 * FILL_U8_SIZE);
  });
});

describe("strokes", () => {
  it("resolves gradient before image and color", () => {
    const { view, bytes } = viewOf();
    writeStrokeFill(view, 0, {
      "stroke-color": "#00ff00",
      "stroke-image": { id: ID },
      "stroke-color-gradient": { type: "linear" },
    } as Stroke);
    expect(bytes[0]).toBe(0x01);
  });

  it("keeps an empty solid record when the stroke has no paint", () => {
    const { view, bytes } = viewOf();
    writeStrokeFill(view, 0, {});
    expect(bytes[0]).toBe(0x00);
    expect(new DataView(bytes.buffer).getUint32(4, true)).toBe(0);
  });

  it("collects the image ids of fills and strokes", () => {
    expect(getImageIds([{ "fill-image": { id: ID } }])).toEqual([ID]);
    expect(getStrokeImageIds([{ "stroke-image": { id: ID } }, {} as Stroke])).toEqual([ID]);
  });
});