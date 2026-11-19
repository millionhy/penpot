import { describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import {
  FILL_U8_SIZE,
  coerce,
  getByteSize,
  getImageIds,
  writeGradientFill,
  writeImageFill,
  writeSolidFill,
  writeTo,
} from "./fills.js";

function buffer(size = 4096): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

describe("fills", () => {
  it("writes a solid fill as type 0 plus the argb word", () => {
    const { view } = buffer();
    const next = writeSolidFill(view, 0, 0.5, "#112233");

    expect(next).toBe(FILL_U8_SIZE);
    expect(view.getUint8(0)).toBe(0x00);
    expect(view.getUint32(4, true)).toBe(0x7f112233);
  });

  it("writes a linear gradient with its stops", () => {
    const { view } = buffer();
    const next = writeGradientFill(view, 0, 0.5, {
      type: "linear",
      "start-x": 0.1,
      "start-y": 0.2,
      "end-x": 0.9,
      "end-y": 0.8,
      width: 1,
      stops: [
        { color: "#ff0000", opacity: 1, offset: 0 },
        { color: "#00ff00", opacity: 0.5, offset: 1 },
      ],
    });

    expect(next).toBe(FILL_U8_SIZE);
    expect(view.getUint8(0)).toBe(0x01);
    expect(view.getFloat32(4, true)).toBeCloseTo(0.1);
    expect(view.getFloat32(16, true)).toBeCloseTo(0.8);
    expect(view.getUint8(20)).toBe(0x7f);
    expect(view.getFloat32(24, true)).toBe(1);
    expect(view.getUint8(28)).toBe(2);

    expect(view.getUint32(32, true)).toBe(0xffff0000);
    expect(view.getFloat32(36, true)).toBe(0);
    expect(view.getUint32(40, true)).toBe(0x7f00ff00);
    expect(view.getFloat32(44, true)).toBe(1);
  });

  it("treats any non-linear gradient as radial", () => {
    const { view } = buffer();
    writeGradientFill(view, 0, 1, { type: "radial", stops: [] });
    expect(view.getUint8(0)).toBe(0x02);
    expect(view.getUint8(28)).toBe(0);
  });

  it("writes an image fill with the uuid, flags and transform", () => {
    const { view } = buffer();
    const next = writeImageFill(view, 0, 0.25, {
      id: "11111111-2222-3333-4444-555555555555",
      width: 640,
      height: 480,
      "keep-aspect-ratio": true,
      transform: { x: 0.1, y: 0.2, width: 0.5, height: 0.6 },
    });

    expect(next).toBe(FILL_U8_SIZE);
    expect(view.getUint8(0)).toBe(0x03);
    expect(view.getUint32(4, true)).toBe(0x11111111);
    expect(view.getUint32(16, true)).toBe(0x55555555);
    expect(view.getUint8(20)).toBe(0x3f);
    expect(view.getUint8(21)).toBe(0x03);
    expect(view.getUint16(22, true)).toBe(0);
    expect(view.getInt32(24, true)).toBe(640);
    expect(view.getInt32(28, true)).toBe(480);
    expect(view.getFloat32(32, true)).toBeCloseTo(0.1);
    expect(view.getFloat32(40, true)).toBeCloseTo(0.5);
  });

  it("defaults a missing image transform to 0,0,1,1", () => {
    const { view } = buffer();
    writeImageFill(view, 0, 1, { id: "11111111-2222-3333-4444-555555555555" });

    expect(view.getUint8(21)).toBe(0);
    expect(view.getFloat32(32, true)).toBe(0);
    expect(view.getFloat32(40, true)).toBe(1);
    expect(view.getFloat32(44, true)).toBe(1);
  });

  it("writes the count header and every record", () => {
    const { bytes } = buffer();
    const fills = [
      { "fill-color": "#ffffff", "fill-opacity": 1 },
      { "fill-color": "#000000", "fill-opacity": 0.5 },
    ];

    expect(getByteSize(fills)).toBe(4 + 2 * FILL_U8_SIZE);
    const next = writeTo(fills, bytes, 0);

    expect(next).toBe(getByteSize(fills));
    expect(bytes[0]).toBe(2);
    expect(bytes[4]).toBe(0x00);
    expect(bytes[4 + FILL_U8_SIZE]).toBe(0x00);
  });

  it("caps the fill list at MAX_FILLS", () => {
    const fills = Array.from({ length: 12 }, () => ({ "fill-color": "#000000" }));
    expect(coerce(fills)).toHaveLength(8);
    expect(getByteSize(coerce(fills))).toBe(4 + 8 * FILL_U8_SIZE);
    expect(coerce(undefined)).toEqual([]);
  });

  it("raises invalid-fill for a record with no payload", () => {
    let cause: unknown;
    try {
      writeTo([{}] as never, new Uint8Array(256), 0);
    } catch (error) {
      cause = error;
    }

    expect(cause).toBeInstanceOf(AppError);
    expect((cause as AppError).data).toMatchObject({ type: "internal", code: "invalid-fill" });
  });

  it("collects the image ids of image fills", () => {
    const image = { id: "11111111-2222-3333-4444-555555555555" };
    expect(
      getImageIds([{ "fill-color": "#000000" }, { "fill-image": image }, { "fill-image": image }]),
    ).toEqual([image.id, image.id]);
  });
});
