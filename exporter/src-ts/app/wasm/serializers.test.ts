import { afterEach, describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { setSerializers } from "./enums.js";
import {
  hexToU32Argb,
  translateBlurType,
  translateFontStyle,
  translateRasterFormat,
  translateShapeType,
  translateTextAlign,
  translateVerticalAlign,
  untranslate,
} from "./serializers.js";

const table = {
  "shape-type": { rect: 0, frame: 1, group: 2, text: 3 },
  "blur-type": { "layer-blur": 0, "background-blur": 1 },
  "vertical-align": { top: 0, center: 1, bottom: 2 },
  "text-align": { left: 0, center: 1, right: 2, justify: 3 },
  "font-style": { normal: 0, italic: 1 },
  "raster-format": { png: 0, jpeg: 1, webp: 2 },
};

afterEach(() => {
  setSerializers(undefined);
});

describe("serializers", () => {
  it("packs a hex color and opacity into the argb word", () => {
    expect(hexToU32Argb("#ff0000", 1)).toBe(0xffff0000);
    expect(hexToU32Argb("#112233", 0.5)).toBe(0x7f112233);
    expect(hexToU32Argb("#000000", undefined)).toBe(0xff000000);
  });

  it("translates enum names and falls back to the documented default", () => {
    setSerializers(table);
    expect(translateShapeType("frame")).toBe(1);
    expect(translateShapeType("unknown")).toBe(0);
    expect(translateShapeType(undefined)).toBe(0);
    expect(translateBlurType(null)).toBe(0);
    expect(translateTextAlign("justify")).toBe(3);
  });

  it("maps regular to normal and unknown styles to normal", () => {
    setSerializers(table);
    expect(translateFontStyle("normal")).toBe(0);
    expect(translateFontStyle("regular")).toBe(0);
    expect(translateFontStyle("italic")).toBe(1);
    expect(translateFontStyle("oblique")).toBe(0);
  });

  it("keeps vertical align on the top default", () => {
    setSerializers(table);
    expect(translateVerticalAlign("center")).toBe(1);
    expect(translateVerticalAlign("middle")).toBe(0);
  });

  it("refuses an unknown raster format instead of defaulting to png", () => {
    setSerializers(table);
    expect(translateRasterFormat("webp")).toBe(2);

    let cause: unknown;
    try {
      translateRasterFormat("gif");
    } catch (error) {
      cause = error;
    }

    expect(cause).toBeInstanceOf(AppError);
    expect((cause as AppError).data).toMatchObject({
      type: "internal",
      code: "unsupported-raster-format",
    });
  });

  it("reverses a numeric discriminant and passes names through", () => {
    setSerializers(table);
    expect(untranslate("vertical-align", 2, "top")).toBe("bottom");
    expect(untranslate("vertical-align", 9, "top")).toBe("top");
    expect(untranslate("vertical-align", undefined, "top")).toBe("top");
    expect(untranslate("vertical-align", "center", "top")).toBe("center");
  });
});
