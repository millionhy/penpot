// Unit tests for the workspace viewport math (lib/workspace-viewport): the
// rect primitives, the initial fit, the zoom/scroll/resize transforms and
// the wheel helpers ported from actions.cljs / normalize_wheel. The module
// is pure, so every case pins the CLJS arithmetic with plain numbers.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceObjects } from "@/lib/workspace";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  adjustToViewport,
  clampZoom,
  initialViewport,
  joinRects,
  normalizeWheel,
  pointToViewport,
  pointsToRect,
  rectCenter,
  resizeViewport,
  scrollBy,
  shapesRect,
  transformRect,
  wheelScrollDeltas,
  wheelZoomFactor,
  zoomBy,
  type ViewportState,
} from "@/lib/workspace-viewport";

function state(overrides: Partial<ViewportState> = {}): ViewportState {
  return {
    zoom: 1,
    vport: { width: 800, height: 600 },
    vbox: { x: 0, y: 0, width: 800, height: 600 },
    ...overrides,
  };
}

describe("pointsToRect", () => {
  it("bounds the points and floors width/height at 0.01", () => {
    expect(pointsToRect([{ x: 5, y: 5 }])).toEqual({ x: 5, y: 5, width: 0.01, height: 0.01 });
    expect(
      pointsToRect([
        { x: 10, y: 20 },
        { x: 40, y: 60 },
      ]),
    ).toEqual({ x: 10, y: 20, width: 30, height: 40 });
  });

  it("returns null for empty and non-numeric input", () => {
    expect(pointsToRect([])).toBeNull();
    expect(pointsToRect(null)).toBeNull();
    expect(pointsToRect(undefined)).toBeNull();
    expect(pointsToRect([{ x: Number.NaN, y: 0 }])).toBeNull();
  });
});

describe("joinRects", () => {
  it("returns the smallest rect containing all of them", () => {
    expect(
      joinRects([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 20, y: 5, width: 10, height: 10 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 30, height: 15 });
  });

  it("returns null for the empty list", () => {
    expect(joinRects([])).toBeNull();
  });
});

describe("shapesRect", () => {
  it("bounds the shapes' points, skipping shapes without them", () => {
    expect(
      shapesRect([
        { id: "a", type: "rect", points: [{ x: 0, y: 0 }, { x: 100, y: 50 }] },
        { id: "b", type: "group" },
      ]),
    ).toEqual({ x: 0, y: 0, width: 100, height: 50 });
  });

  it("returns null when no shape has points", () => {
    expect(shapesRect([{ id: "a", type: "group" }])).toBeNull();
  });
});

describe("rectCenter / transformRect", () => {
  it("scales every corner around the center point", () => {
    const rect = { x: 0, y: 0, width: 800, height: 600 };
    expect(rectCenter(rect)).toEqual({ x: 400, y: 300 });
    expect(transformRect(rect, 0.5, rectCenter(rect))).toEqual({
      x: 200,
      y: 150,
      width: 400,
      height: 300,
    });
  });
});

describe("adjustToViewport", () => {
  it("widens the srect to the viewport aspect when the viewport is wider", () => {
    expect(
      adjustToViewport(
        { x: 0, y: 0, width: 1000, height: 500 },
        { x: 10, y: 20, width: 100, height: 100 },
      ),
    ).toEqual({ x: -40, y: 20, width: 200, height: 100 });
  });

  it("heightens the srect when the viewport is taller", () => {
    expect(
      adjustToViewport(
        { x: 0, y: 0, width: 500, height: 1000 },
        { x: 10, y: 20, width: 100, height: 100 },
      ),
    ).toEqual({ x: 10, y: -30, width: 100, height: 200 });
  });

  it("keeps the srect when the aspects match and applies the padding", () => {
    expect(
      adjustToViewport(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 10, y: 20, width: 50, height: 50 },
        { padding: 5 },
      ),
    ).toEqual({ x: 5, y: 15, width: 60, height: 60 });
  });

  it("anchors a viewport/minZoom box on the srect when the fit would be smaller", () => {
    expect(
      adjustToViewport(
        { x: 0, y: 0, width: 100, height: 100 },
        { x: 10, y: 20, width: 50, height: 50 },
        { minZoom: 4 },
      ),
    ).toEqual({ x: -2.5, y: 7.5, width: 25, height: 25 });
  });
});

describe("initialViewport", () => {
  const vport = { x: 0, y: 0, width: 800, height: 600 };

  it("pins the world origin to the viewport corner for an empty page", () => {
    expect(initialViewport(vport, {})).toEqual({
      zoom: 1,
      vport: { width: 800, height: 600 },
      vbox: { x: 0, y: 0, width: 800, height: 600 },
    });
  });

  it("scales content larger than the viewport down with a 40px padding", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: { id: ZERO_UUID, type: "frame", shapes: ["a"] },
      a: {
        id: "a",
        type: "frame",
        points: [
          { x: 0, y: 0 },
          { x: 2000, y: 1200 },
        ],
      },
    };
    const fitted = initialViewport(vport, objects);
    expect(fitted.zoom).toBeCloseTo(800 / 2080, 12);
    expect(fitted.vbox).toEqual({ x: -40, y: -180, width: 2080, height: 1560 });
  });

  it("centers content that fits on the viewport at zoom 1", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: { id: ZERO_UUID, type: "frame", shapes: ["a"] },
      a: {
        id: "a",
        type: "frame",
        points: [
          { x: 0, y: 0 },
          { x: 200, y: 100 },
        ],
      },
    };
    expect(initialViewport(vport, objects)).toEqual({
      zoom: 1,
      vport: { width: 800, height: 600 },
      vbox: { x: -300, y: -250, width: 800, height: 600 },
    });
  });
});

describe("clampZoom", () => {
  it("clamps to the set-zoom limits", () => {
    expect(clampZoom(0.001)).toBe(MIN_ZOOM);
    expect(clampZoom(500)).toBe(MAX_ZOOM);
    expect(clampZoom(1.5)).toBe(1.5);
  });
});

describe("zoomBy", () => {
  it("scales around the box center when no pivot is given", () => {
    const next = zoomBy(state(), null, 2);
    expect(next.zoom).toBe(2);
    expect(next.vbox).toEqual({ x: 200, y: 150, width: 400, height: 300 });
  });

  it("keeps the world point under a given pivot", () => {
    const next = zoomBy(state(), { x: 200, y: 150 }, 2);
    expect(next.zoom).toBe(2);
    expect(next.vbox).toEqual({ x: 100, y: 75, width: 400, height: 300 });
  });

  it("clamps at MIN_ZOOM and compensates the box scale", () => {
    const next = zoomBy(state({ zoom: 0.02 }), { x: 0, y: 0 }, 0.1);
    expect(next.zoom).toBe(MIN_ZOOM);
    expect(next.vbox).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
  });

  it("clamps at MAX_ZOOM and compensates the box scale", () => {
    const next = zoomBy(state({ zoom: 100 }), null, 4);
    expect(next.zoom).toBe(MAX_ZOOM);
    expect(next.vbox).toEqual({ x: 200, y: 150, width: 400, height: 300 });
  });
});

describe("scrollBy", () => {
  it("pans the box by the world delta, keeping the zoom", () => {
    expect(scrollBy(state(), 10, -5)).toEqual({
      zoom: 1,
      vport: { width: 800, height: 600 },
      vbox: { x: 10, y: -5, width: 800, height: 600 },
    });
  });
});

describe("resizeViewport", () => {
  const resized = { zoom: 1, vport: { width: 400, height: 300 } };

  it("keeps the box center with the center resize", () => {
    const next = resizeViewport(
      state({ vbox: { x: 100, y: 100, width: 800, height: 600 } }),
      resized.vport,
    );
    expect(next).toEqual({ ...resized, vbox: { x: 300, y: 250, width: 400, height: 300 } });
  });

  it("anchors the box on the left edge with the left resize", () => {
    const next = resizeViewport(
      state({ vbox: { x: 100, y: 100, width: 800, height: 600 } }),
      resized.vport,
      "left",
    );
    expect(next.vbox).toEqual({ x: 500, y: 250, width: 400, height: 300 });
  });

  it("anchors the box on the right edge with the right resize", () => {
    const next = resizeViewport(
      state({ vbox: { x: 100, y: 100, width: 800, height: 600 } }),
      resized.vport,
      "right",
    );
    expect(next.vbox).toEqual({ x: 100, y: 250, width: 400, height: 300 });
  });

  it("anchors the box on the top edge with the top resize", () => {
    const next = resizeViewport(
      state({ vbox: { x: 100, y: 100, width: 800, height: 600 } }),
      resized.vport,
      "top",
    );
    expect(next.vbox).toEqual({ x: 300, y: 400, width: 400, height: 300 });
  });

  it("anchors the box on the bottom edge with the bottom resize", () => {
    const next = resizeViewport(
      state({ vbox: { x: 100, y: 100, width: 800, height: 600 } }),
      resized.vport,
      "bottom",
    );
    expect(next.vbox).toEqual({ x: 300, y: 100, width: 400, height: 300 });
  });

  it("keeps the old state for an almost-zero size", () => {
    const before = state();
    expect(resizeViewport(before, { width: 0, height: 600 })).toBe(before);
    expect(resizeViewport(before, { width: 800, height: 0 })).toBe(before);
  });
});

describe("wheelZoomFactor", () => {
  it("zooms out for a positive (downward) delta and in for a negative one", () => {
    expect(wheelZoomFactor(100)).toBeCloseTo(1 / 1.57, 12);
    expect(wheelZoomFactor(-100)).toBeCloseTo(1.57, 12);
    expect(wheelZoomFactor(0)).toBe(1);
  });
});

describe("pointToViewport", () => {
  it("maps client coordinates to the world box", () => {
    expect(
      pointToViewport({ x: 500, y: 400 }, { x: 100, y: 100 }, 2, {
        x: 0,
        y: 0,
        width: 800,
        height: 600,
      }),
    ).toEqual({ x: 200, y: 150 });
  });
});

describe("wheelScrollDeltas", () => {
  it("remaps the vertical wheel to horizontal panning on non-mac shift", () => {
    expect(wheelScrollDeltas(5, 10, 2, true, false)).toEqual({ x: 5, y: 0 });
  });

  it("divides both deltas by the zoom otherwise", () => {
    expect(wheelScrollDeltas(5, 10, 2, false, false)).toEqual({ x: 2.5, y: 5 });
  });

  it("keeps the deltas on mac shift (deltaX arrives on its own)", () => {
    expect(wheelScrollDeltas(5, 10, 2, true, true)).toEqual({ x: 2.5, y: 5 });
  });
});

describe("normalizeWheel", () => {
  it("passes pixel deltas through and falls back to a spin sign", () => {
    expect(normalizeWheel({ deltaX: 0, deltaY: 120 })).toEqual({
      spinX: 0,
      spinY: 1,
      pixelX: 0,
      pixelY: 120,
    });
    expect(normalizeWheel({ deltaY: -5 })).toEqual({
      spinX: 0,
      spinY: -1,
      pixelX: 0,
      pixelY: -5,
    });
  });

  it("scales line and page delta modes", () => {
    expect(normalizeWheel({ deltaY: 3, deltaMode: 1 }).pixelY).toBe(120);
    expect(normalizeWheel({ deltaY: 1, deltaMode: 2 }).pixelY).toBe(800);
  });

  it("reads the legacy wheelDelta* fields", () => {
    expect(normalizeWheel({ wheelDelta: -120 })).toEqual({
      spinX: 0,
      spinY: 1,
      pixelX: 0,
      pixelY: 10,
    });
    expect(normalizeWheel({ wheelDeltaX: -240 })).toEqual({
      spinX: 2,
      spinY: 0,
      pixelX: 20,
      pixelY: 0,
    });
  });

  it("moves the detail count to the horizontal axis for DOMMouseScroll", () => {
    expect(normalizeWheel({ detail: 2, axis: 1, HORIZONTAL_AXIS: 1 })).toEqual({
      spinX: 2,
      spinY: 0,
      pixelX: 20,
      pixelY: 0,
    });
  });
});
