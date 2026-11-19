// app.images: the image ids a scene references. Pure walking, so these are
// plain-object cases.

import { describe, expect, it } from "vitest";

import { sceneImageIds, shapeImageIds } from "./images.js";
import type { Shape } from "./wasm/upload.js";

function shape(entry: Record<string, unknown>): Shape {
  return entry as unknown as Shape;
}

function imageFill(id: string): Record<string, unknown> {
  return { "fill-image": { id } };
}

describe("shapeImageIds", () => {
  it("collects the ids from image fills", () => {
    const ids = shapeImageIds(shape({ type: "rect", fills: [imageFill("a"), { "fill-color": "#fff" }] }));

    expect([...ids]).toEqual(["a"]);
  });

  it("collects the ids from stroke images", () => {
    const ids = shapeImageIds(
      shape({
        type: "rect",
        strokes: [{ "stroke-image": { id: "b" } }, { "stroke-color": "#000" }],
      }),
    );

    expect([...ids]).toEqual(["b"]);
  });

  it("collects the ids from a text shape's span fills", () => {
    const ids = shapeImageIds(
      shape({
        type: "text",
        content: {
          children: [{ fills: [imageFill("c")] }, { children: [{ fills: [imageFill("d")] }] }],
        },
      }),
    );

    expect([...ids]).toEqual(["c", "d"]);
  });

  it("ignores non-image content on non-text shapes", () => {
    const ids = shapeImageIds(shape({ type: "path", content: [imageFill("e")] }));

    expect([...ids]).toEqual([]);
  });

  it("dedupes an id used by fills, strokes and spans", () => {
    const ids = shapeImageIds(
      shape({
        type: "text",
        fills: [imageFill("f")],
        strokes: [{ "stroke-image": { id: "f" } }],
        content: { fills: [imageFill("f")] },
      }),
    );

    expect([...ids]).toEqual(["f"]);
  });

  it("caps the fills it walks at the serializer limit", () => {
    const fills = Array.from({ length: 10 }, (_, index) => imageFill(`fill-${index}`));
    const ids = shapeImageIds(shape({ type: "rect", fills }));

    expect(ids.size).toBe(8);
    expect([...ids]).toEqual(fills.slice(0, 8).map((_fill, index) => `fill-${index}`));
  });

  it("tolerates missing fills, strokes and content", () => {
    expect(shapeImageIds(shape({ type: "rect" })).size).toBe(0);
  });
});

describe("sceneImageIds", () => {
  it("merges the ids of every shape", () => {
    const ids = sceneImageIds({
      one: shape({ type: "rect", fills: [imageFill("a")] }),
      two: shape({ type: "rect", strokes: [{ "stroke-image": { id: "b" } }] }),
    });

    expect([...ids]).toEqual(["a", "b"]);
  });
});