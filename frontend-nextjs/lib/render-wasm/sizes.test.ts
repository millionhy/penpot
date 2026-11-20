import { describe, expect, it } from "vitest";

import { calculateSize } from "@/lib/render-wasm/sizes";

// The engine version reads the decoded page objects directly; these models
// are the kebab-case maps the transit decoder produces.
function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    type: "frame",
    selrect: { x: 10, y: 20, width: 100, height: 50 },
    ...overrides,
  };
}

describe("calculateSize", () => {
  it("reads the padded bounds of the frame and applies the zoom", () => {
    const frameShape = frame();

    const size = calculateSize({ [String(frameShape.id)]: frameShape }, frameShape, 2);

    // No strokes, shadows or blur: the padding is zero and the bounds are
    // the selrect. The zoom only scales width/height.
    expect(size).toEqual({
      baseWidth: 100,
      baseHeight: 50,
      x: 10,
      y: 20,
      width: 200,
      height: 100,
    });
  });

  it("pads the frame stroke and joins a child box that paints outside", () => {
    const root = frame({
      id: "00000000-0000-0000-0000-000000000000",
      selrect: { x: 0, y: 0, width: 100, height: 100 },
      "show-content": true,
      strokes: [{ "stroke-width": 10, "stroke-alignment": "center" }],
      shapes: ["22222222-2222-2222-2222-222222222222"],
    });
    const child = {
      id: "22222222-2222-2222-2222-222222222222",
      type: "rect",
      "parent-id": root.id,
      selrect: { x: 90, y: 90, width: 20, height: 20 },
    };
    const objects = { [String(root.id)]: root, [child.id]: child };

    // The frame's own 10px centred stroke pads by ceil(sqrt(2 * 5 * 5)) = 8
    // on every side (-8..108). The child runs to 110 but contributes no
    // stroke margin of its own: the CLJS get-object-bounds calls
    // calculate-base-bounds on every child with the default ignore-margin?,
    // so only the root's padding counts.
    const size = calculateSize(objects, root, 1);

    expect(size).toEqual({
      baseWidth: 118,
      baseHeight: 118,
      x: -8,
      y: -8,
      width: 118,
      height: 118,
    });
  });

  it("answers a degenerate 0.01 box instead of zero", () => {
    const frameShape = frame({ selrect: { x: 0, y: 0, width: 0, height: 0 } });

    const size = calculateSize({}, frameShape, 1);

    expect(size.baseWidth).toBeCloseTo(0.01);
    expect(size.baseHeight).toBeCloseTo(0.01);
  });
});
