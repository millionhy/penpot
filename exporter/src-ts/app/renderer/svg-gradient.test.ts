// app.renderer.svg-gradient: the gradient definitions the recoloured layers
// reference by id.

import { describe, expect, it } from "vitest";

import { dataToGradientDef } from "./svg-gradient.js";

const STOPS = [
  { offset: 0, color: "#ff0000", opacity: 1 },
  { offset: "100%", color: "#0000ff", opacity: 0.5 },
];

describe("dataToGradientDef", () => {
  it("builds a linear gradient keyed by the layer id and the colour", () => {
    const node = dataToGradientDef("board", [
      "#ff0000",
      { type: "gradient", gradient: { type: "linear", stops: STOPS } },
    ]);

    expect(node).toMatchObject({
      type: "element",
      name: "linearGradient",
      attributes: { id: "gradient-board-ff0000", x1: "0.5", y1: "1", x2: "0.5", y2: "0" },
    });
    expect(node.elements).toEqual([
      {
        type: "element",
        name: "stop",
        attributes: { offset: "0", "stop-color": "#ff0000", "stop-opacity": "1" },
      },
      {
        type: "element",
        name: "stop",
        attributes: { offset: "100%", "stop-color": "#0000ff", "stop-opacity": "0.5" },
      },
    ]);
  });

  it("treats anything that is not linear as radial", () => {
    const node = dataToGradientDef("board", [
      "#00ff00",
      { type: "gradient", gradient: { type: "radial", stops: [] } },
    ]);

    expect(node).toMatchObject({
      name: "radialGradient",
      attributes: { id: "gradient-board-00ff00", cx: "0.5", cy: "0.5", r: "0.5" },
    });
    expect(node.elements).toEqual([]);
  });
});
