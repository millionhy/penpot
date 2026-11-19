import { describe, expect, it } from "vitest";
import {
  translateBlendMode,
  translateConstraintH,
  translateFontStyle,
  translateShapeType,
  translateStrokeCap,
  translateStructureModifierType,
  translateTextAlign,
} from "./serializers";

describe("translate", () => {
  it("reads the table by name", () => {
    expect(translateShapeType("frame")).toBe(0);
    expect(translateShapeType("text")).toBe(5);
    expect(translateBlendMode("multiply")).toBe(24);
  });

  it("falls back to the table default for unknown names", () => {
    expect(translateShapeType("nope")).toBe(3); // rect
    expect(translateShapeType(undefined)).toBe(3);
    expect(translateBlendMode("nope")).toBe(3); // normal
    expect(translateConstraintH(null)).toBe(0); // none
  });

  it("answers undefined where the CLJS translator has no default", () => {
    expect(translateStrokeCap("round")).toBe(6);
    expect(translateTextAlign("justify")).toBe(3);
    expect(translateFontStyle("italic")).toBe(1);
    expect(translateFontStyle("regular")).toBe(0);
  });
});

describe("translateStructureModifierType", () => {
  it("maps the three modifier kinds", () => {
    expect(translateStructureModifierType("remove-children")).toBe(1);
    expect(translateStructureModifierType("add-children")).toBe(2);
    expect(translateStructureModifierType("scale-content")).toBe(3);
    expect(translateStructureModifierType("unknown")).toBeUndefined();
  });
});