import { describe, expect, it } from "vitest";
import {
  actionable,
  activateInteraction,
  calcOverlayPosition,
  calculateDelta,
  calculateWrapper,
  deactivateInteraction,
  findRelativeToBaseFrame,
  fixedScroll,
  getChildrenIds,
  getShapeFrame,
  hotspotShapes,
  ignoreFrameShape,
  interactionsByEvent,
  invertDirection,
  isDirectChildOfRoot,
  isFixed,
  isRoot,
  isRootFrame,
  type InteractionShape,
  type Point,
  type ShapeReader,
  type ViewerInteraction,
} from "@/lib/viewer-interactions";
import { ZERO_UUID } from "@/lib/viewer";
import type { ViewerSize } from "@/lib/render-wasm/sizes";

// A prepared (vbox-space) shape, with the kebab-case keys of the decoded
// bundle.
function ishape(overrides: Partial<InteractionShape> & { id: string }): InteractionShape {
  return { type: "rect", ...overrides };
}

function readerOf(objects: Record<string, InteractionShape>): ShapeReader {
  return (id) => objects[id];
}

function rect(x: number, y: number, width: number, height: number) {
  return { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height };
}

// The sample page: the root, a top-level frame f1 with an interactive shape
// s1 and a nested frame nf (holding n1), and an overlay target frame f2.
function sampleObjects(): Record<string, InteractionShape> {
  return {
    [ZERO_UUID]: ishape({ id: ZERO_UUID, type: "frame", shapes: ["f1", "f2"] }),
    f1: ishape({
      id: "f1",
      type: "frame",
      "parent-id": ZERO_UUID,
      "frame-id": ZERO_UUID,
      x: 0,
      y: 0,
      selrect: rect(0, 0, 100, 100),
      shapes: ["s1", "nf"],
    }),
    f2: ishape({
      id: "f2",
      type: "frame",
      "parent-id": ZERO_UUID,
      "frame-id": ZERO_UUID,
      x: 200,
      y: 0,
      selrect: rect(0, 0, 40, 30),
    }),
    s1: ishape({
      id: "s1",
      "parent-id": "f1",
      "frame-id": "f1",
      x: 60,
      y: 30,
      selrect: rect(60, 30, 20, 10),
      interactions: [{ "action-type": "navigate", "event-type": "click", destination: "f2" }],
    }),
    nf: ishape({
      id: "nf",
      type: "frame",
      "parent-id": "f1",
      "frame-id": "f1",
      x: 20,
      y: 30,
      selrect: rect(20, 30, 50, 40),
      shapes: ["n1"],
    }),
    n1: ishape({
      id: "n1",
      "parent-id": "nf",
      "frame-id": "nf",
      x: 70,
      y: 60,
      selrect: rect(70, 60, 10, 10),
    }),
  };
}

describe("actionable", () => {
  it("is true only with a click interaction", () => {
    expect(actionable([{ "event-type": "mouse-press" }])).toBe(false);
    expect(actionable([{ "event-type": "click" }])).toBe(true);
    expect(actionable([{ "event-type": "mouse-press" }, { "event-type": "click" }])).toBe(true);
    expect(actionable([])).toBe(false);
    expect(actionable(null)).toBe(false);
  });
});

describe("interactionsByEvent", () => {
  it("keeps the matching interactions in their original order", () => {
    const shape = ishape({
      id: "s1",
      interactions: [
        { "event-type": "click" },
        { "event-type": "mouse-over" },
        { "event-type": "mouse-enter" },
      ],
    });
    expect(interactionsByEvent(shape, ["click", "mouse-press"])).toEqual([
      { "event-type": "click" },
    ]);
    // The pointer-enter handler takes both kinds in one pass.
    expect(interactionsByEvent(shape, ["mouse-enter", "mouse-over"])).toEqual([
      { "event-type": "mouse-over" },
      { "event-type": "mouse-enter" },
    ]);
  });

  it("answers empty without interactions or without a match", () => {
    expect(interactionsByEvent(ishape({ id: "s1" }), ["click"])).toEqual([]);
    expect(
      interactionsByEvent(ishape({ id: "s1", interactions: [{ "event-type": "click" }] }), [
        "mouse-press",
      ]),
    ).toEqual([]);
  });
});

describe("shape helpers", () => {
  it("isRoot only answers the zero uuid frame", () => {
    const objects = sampleObjects();
    expect(isRoot(objects[ZERO_UUID])).toBe(true);
    expect(isRoot(objects.f1)).toBe(false);
    expect(isRoot(undefined)).toBe(false);
    expect(isRoot({ id: ZERO_UUID, type: "rect" })).toBe(false);
  });

  it("isRootFrame marks frames hanging directly off the root", () => {
    const objects = sampleObjects();
    const read = readerOf(objects);
    expect(isRootFrame(read, "f1")).toBe(true);
    expect(isRootFrame(read, "nf")).toBe(false);
    expect(isRootFrame(read, ZERO_UUID)).toBe(false);
    expect(isRootFrame(read, "s1")).toBe(false);
  });

  it("isDirectChildOfRoot reads the frame-id", () => {
    const objects = sampleObjects();
    expect(isDirectChildOfRoot(objects.f1)).toBe(true);
    expect(isDirectChildOfRoot(objects.nf)).toBe(false);
  });

  it("getShapeFrame answers frames themselves and the containing frame of shapes", () => {
    const objects = sampleObjects();
    const read = readerOf(objects);
    expect(getShapeFrame(read, objects.nf)).toBe(objects.nf);
    expect(getShapeFrame(read, objects.n1)).toBe(objects.nf);
    expect(getShapeFrame(read, ishape({ id: "orphan" }))).toBeUndefined();
  });

  it("getChildrenIds lists the direct children before their subtrees", () => {
    const objects = sampleObjects();
    expect(getChildrenIds(readerOf(objects), "f1")).toEqual(["s1", "nf", "n1"]);
    expect(getChildrenIds(readerOf(objects), "n1")).toEqual([]);
  });

  it("keeps the CLJS into/mapcat order for deeper trees", () => {
    const objects: Record<string, InteractionShape> = {
      a: ishape({ id: "a", shapes: ["a1", "b"] }),
      a1: ishape({ id: "a1", shapes: ["a11"] }),
      a11: ishape({ id: "a11" }),
      b: ishape({ id: "b", shapes: ["b1"] }),
      b1: ishape({ id: "b1" }),
    };
    expect(getChildrenIds(readerOf(objects), "a")).toEqual(["a1", "b", "a11", "b1"]);
  });
});

describe("hotspotShapes", () => {
  // The frame itself, an interactive child, a hidden child, a child without
  // interactions and a dangling id, all in the getChildrenIds order.
  function hotspotObjects(): Record<string, InteractionShape> {
    const click = [{ "event-type": "click" }];
    return {
      f1: ishape({
        id: "f1",
        type: "frame",
        shapes: ["s1", "h1", "p1", "gap"],
        interactions: click,
      }),
      s1: ishape({ id: "s1", interactions: click }),
      h1: ishape({ id: "h1", hidden: true, interactions: click }),
      p1: ishape({ id: "p1" }),
    };
  }

  it("lists the frame itself and its interactive subtree, in order", () => {
    const objects = hotspotObjects();
    const ids = hotspotShapes(readerOf(objects), "f1").map((shape) => shape.id);
    expect(ids).toEqual(["f1", "s1"]);
  });

  it("keeps out hidden shapes, shapes without interactions and dangling ids", () => {
    const objects = hotspotObjects();
    const read = readerOf(objects);
    expect(hotspotShapes(read, "f1")).toEqual([objects.f1, objects.s1]);
    // A leaf without interactions answers nothing.
    expect(hotspotShapes(read, "p1")).toEqual([]);
  });

  it("leaves out a hidden frame itself even with interactions", () => {
    const click = [{ "event-type": "click" }];
    const objects: Record<string, InteractionShape> = {
      f1: ishape({ id: "f1", type: "frame", hidden: true, interactions: click }),
    };
    expect(hotspotShapes(readerOf(objects), "f1")).toEqual([]);
  });

  it("applies the filter before the lookup", () => {
    const objects = hotspotObjects();
    const seen: string[] = [];
    const filter = (id: string): boolean => {
      seen.push(id);
      return id !== "f1";
    };
    expect(hotspotShapes(readerOf(objects), "f1", filter)).toEqual([objects.s1]);
    // Every candidate id reaches the filter, dangling ones included.
    expect(seen).toEqual(["f1", "s1", "h1", "p1", "gap"]);
  });
});

describe("fixed scroll", () => {
  it("fixedScroll needs the flag, the direct parent and a non-root frame", () => {
    const base = { id: "a", "parent-id": "f", "frame-id": "f" };
    expect(fixedScroll({ ...base, "fixed-scroll": true })).toBe(true);
    expect(fixedScroll({ ...base })).toBe(false);
    expect(fixedScroll({ ...base, "fixed-scroll": true, "parent-id": "g" })).toBe(false);
    expect(fixedScroll({ ...base, "fixed-scroll": true, "frame-id": ZERO_UUID })).toBe(false);
  });

  it("isFixed checks the shape, its subtree and its ancestors", () => {
    const objects: Record<string, InteractionShape> = {
      [ZERO_UUID]: ishape({ id: ZERO_UUID, type: "frame", shapes: ["f1"] }),
      f1: ishape({
        id: "f1",
        type: "frame",
        "parent-id": ZERO_UUID,
        "frame-id": ZERO_UUID,
        shapes: ["fixed1", "plain", "nf"],
      }),
      fixed1: ishape({
        id: "fixed1",
        "parent-id": "f1",
        "frame-id": "f1",
        "fixed-scroll": true,
      }),
      plain: ishape({ id: "plain", "parent-id": "f1", "frame-id": "f1" }),
      nf: ishape({
        id: "nf",
        type: "frame",
        "parent-id": "f1",
        "frame-id": "f1",
        "fixed-scroll": true,
      }),
      inner: ishape({ id: "inner", "parent-id": "nf", "frame-id": "nf" }),
    };
    const read = readerOf(objects);
    // The frame carries a fixed child.
    expect(isFixed(read, "f1")).toBe(true);
    // The shape itself is fixed.
    expect(isFixed(read, "fixed1")).toBe(true);
    // The ancestor walk stops at the top-level frame but keeps the nested
    // fixed frame in between.
    expect(isFixed(read, "inner")).toBe(true);
    expect(isFixed(read, "plain")).toBe(false);
    expect(isFixed(read, null)).toBe(false);
    expect(isFixed(read, "missing")).toBe(false);
  });
});

describe("findRelativeToBaseFrame", () => {
  it("answers frames themselves", () => {
    const objects = sampleObjects();
    const read = readerOf(objects);
    expect(findRelativeToBaseFrame(objects.nf, read, new Set(["ov"]), objects.f1)).toBe(objects.nf);
  });

  it("walks up the parent chain while inside overlays", () => {
    const objects = sampleObjects();
    const read = readerOf(objects);
    // n1 -> nf (a frame) stops the walk.
    expect(findRelativeToBaseFrame(objects.n1, read, new Set(["ov"]), objects.f1)).toBe(objects.nf);
  });

  it("answers the base frame with no overlays or no shape", () => {
    const objects = sampleObjects();
    const read = readerOf(objects);
    expect(findRelativeToBaseFrame(objects.s1, read, new Set(), objects.f1)).toBe(objects.f1);
    expect(findRelativeToBaseFrame(undefined, read, new Set(["ov"]), objects.f1)).toBe(objects.f1);
  });

  it("answers the root itself through the frame branch", () => {
    const objects = sampleObjects();
    const read = readerOf(objects);
    // The root is a frame and the frame branch comes first: the root? check
    // in the CLJS never fires. Ported as is.
    expect(findRelativeToBaseFrame(objects[ZERO_UUID], read, new Set(["ov"]), objects.f1)).toBe(
      objects[ZERO_UUID],
    );
  });
});

describe("ignoreFrameShape", () => {
  it("demotes frames to rects unless the interaction is manual", () => {
    const objects = sampleObjects();
    const ignored = ignoreFrameShape(objects.f1, false);
    expect(ignored.type).toBe("rect");
    expect(objects.f1.type).toBe("frame");
    expect(ignoreFrameShape(objects.f1, true)).toBe(objects.f1);
    expect(ignoreFrameShape(objects.s1, false).type).toBe("rect");
  });
});

describe("calcOverlayPosition", () => {
  it("answers (0,0) top-left without a destination frame", () => {
    const objects = sampleObjects();
    const read = readerOf(objects);
    const interaction: ViewerInteraction = { "overlay-pos-type": "center" };
    expect(calcOverlayPosition(interaction, objects.s1, read, objects.f1, objects.f1, undefined, { x: 0, y: 0 })).toEqual([
      { x: 0, y: 0 },
      ["top", "left"],
    ]);
  });

  it("centers against the frame selrect for the auto relative", () => {
    const objects = sampleObjects();
    const read = readerOf(objects);
    const interaction: ViewerInteraction = { "overlay-pos-type": "center" };
    const [position, snapTo] = calcOverlayPosition(
      interaction,
      objects.s1,
      read,
      objects.f1,
      objects.f1,
      objects.f2,
      { x: 0, y: 0 },
    );
    // base (0,0) + ((100-40)/2, (100-30)/2).
    expect(position).toEqual({ x: 30, y: 35 });
    expect(snapTo).toEqual(["center", "center"]);
  });

  it("aligns the corner positions against the relative shape", () => {
    const objects = sampleObjects();
    const read = readerOf(objects);
    const [position, snapTo] = calcOverlayPosition(
      { "overlay-pos-type": "bottom-right", "position-relative-to": "s1" },
      objects.s1,
      read,
      objects.s1,
      objects.f1,
      objects.f2,
      { x: 0, y: 0 },
    );
    // adjusted = s1 - f1 = (60, 30); base = adjusted. gap = s1 - f2.
    expect(position).toEqual({ x: 60 + (20 - 40), y: 30 + (10 - 30) });
    expect(snapTo).toEqual(["bottom", "right"]);
  });

  it("adds the nested frame origin and the relative offset for manual positions", () => {
    const objects = sampleObjects();
    const read = readerOf(objects);
    // n1 lives in the nested frame nf: the manual offset gains nf's origin
    // and the overlay-position is re-based against n1's frame offset.
    const [position, snapTo] = calcOverlayPosition(
      { "overlay-pos-type": "manual", "overlay-position": { x: 5, y: 6 } },
      objects.n1,
      read,
      objects.n1,
      objects.f1,
      objects.f2,
      { x: 1, y: 2 },
    );
    // frame-offset (1,2) + nf (20,30) + overlay (5,6): the n1 selrect offsets
    // cancel out between the base position and the overlay correction.
    expect(position).toEqual({ x: 26, y: 38 });
    expect(snapTo).toEqual(["top", "left"]);
  });

  it("keeps the raw overlay-position for frame relative shapes", () => {
    const objects = sampleObjects();
    const read = readerOf(objects);
    const [position] = calcOverlayPosition(
      { "overlay-pos-type": "manual", "overlay-position": { x: 4, y: 5 } },
      objects.s1,
      read,
      objects.nf,
      objects.f1,
      objects.f2,
      { x: 0, y: 0 },
    );
    // nf is a frame: no overlay re-basing; base = adjusted (nf - f1).
    expect(position).toEqual({ x: 20 + 4, y: 30 + 5 });
  });
});

describe("activateInteraction", () => {
  it("answers the navigate action with its flags", () => {
    const objects = sampleObjects();
    const action = activateInteraction(
      {
        "action-type": "navigate",
        destination: "f2",
        "preserve-scroll": true,
        animation: { "animation-type": "slide", direction: "right" },
      },
      objects.s1,
      objects.f1,
      { x: 0, y: 0 },
      readerOf(objects),
      [],
    );
    expect(action).toEqual({
      kind: "navigate",
      frameId: "f2",
      animation: { "animation-type": "slide", direction: "right" },
      preserveScroll: true,
    });
  });

  it("answers a navigate without destination with null", () => {
    const objects = sampleObjects();
    const action = activateInteraction(
      { "action-type": "navigate" },
      objects.s1,
      objects.f1,
      { x: 0, y: 0 },
      readerOf(objects),
      [],
    );
    expect(action).toBeNull();
  });

  it("answers the open-overlay spec", () => {
    const objects = sampleObjects();
    const action = activateInteraction(
      {
        "action-type": "open-overlay",
        destination: "f2",
        "overlay-pos-type": "center",
        "close-click-outside": true,
        "background-overlay": true,
      },
      objects.s1,
      objects.f1,
      { x: 0, y: 0 },
      readerOf(objects),
      [],
    );
    expect(action).toEqual({
      kind: "open-overlay",
      overlay: {
        frameId: "f2",
        position: { x: 30, y: 35 },
        snapTo: ["center", "center"],
        closeClickOutside: true,
        backgroundOverlay: true,
        animation: undefined,
        fixedSource: false,
      },
    });
  });

  it("detects the fixed source through the relative id for open-overlay", () => {
    const objects = sampleObjects();
    // s1 is pinned to its frame, so an overlay positioned against it follows
    // the viewport. The probe reads position-relative-to, not the target.
    objects.s1["fixed-scroll"] = true;
    const action = activateInteraction(
      {
        "action-type": "open-overlay",
        destination: "f2",
        "overlay-pos-type": "center",
        "position-relative-to": "s1",
      },
      objects.s1,
      objects.f1,
      { x: 0, y: 0 },
      readerOf(objects),
      [],
    );
    expect(action).toEqual({
      kind: "open-overlay",
      overlay: {
        frameId: "f2",
        // s1 (60,30,20,10) against f2 (40x30): (60-10, 30-10).
        position: { x: 50, y: 20 },
        snapTo: ["center", "center"],
        closeClickOutside: undefined,
        backgroundOverlay: undefined,
        animation: undefined,
        fixedSource: true,
      },
    });
  });

  it("answers close-overlay from the destination, the frame itself or its frame", () => {
    const objects = sampleObjects();
    const read = readerOf(objects);
    const animation = { "animation-type": "dissolve" as const };

    expect(
      activateInteraction(
        { "action-type": "close-overlay", destination: "f2", animation },
        objects.s1,
        objects.f1,
        { x: 0, y: 0 },
        read,
        [],
      ),
    ).toEqual({ kind: "close-overlay", frameId: "f2", animation });

    // A frame that is itself an open overlay closes itself.
    expect(
      activateInteraction(
        { "action-type": "close-overlay" },
        objects.nf,
        objects.f1,
        { x: 0, y: 0 },
        read,
        ["nf"],
      ),
    ).toEqual({ kind: "close-overlay", frameId: "nf", animation: undefined });

    // Otherwise the shape's own frame closes (s1 -> f1).
    expect(
      activateInteraction(
        { "action-type": "close-overlay" },
        objects.s1,
        objects.f1,
        { x: 0, y: 0 },
        read,
        [],
      ),
    ).toEqual({ kind: "close-overlay", frameId: "f1", animation: undefined });
  });

  it("answers prev-screen and open-url", () => {
    const objects = sampleObjects();
    const read = readerOf(objects);
    expect(
      activateInteraction(
        { "action-type": "prev-screen" },
        objects.s1,
        objects.f1,
        { x: 0, y: 0 },
        read,
        [],
      ),
    ).toEqual({ kind: "prev-screen" });
    expect(
      activateInteraction(
        { "action-type": "open-url", url: "https://example.com" },
        objects.s1,
        objects.f1,
        { x: 0, y: 0 },
        read,
        [],
      ),
    ).toEqual({ kind: "open-url", url: "https://example.com" });
    expect(
      activateInteraction(
        { "action-type": "open-url" },
        objects.s1,
        objects.f1,
        { x: 0, y: 0 },
        read,
        [],
      ),
    ).toBeNull();
  });
});

describe("deactivateInteraction", () => {
  it("closes an open-overlay without animation", () => {
    const objects = sampleObjects();
    const action = deactivateInteraction(
      {
        "action-type": "open-overlay",
        destination: "f2",
        animation: { "animation-type": "slide", direction: "right" },
      },
      objects.s1,
      objects.f1,
      { x: 0, y: 0 },
      readerOf(objects),
      [],
    );
    expect(action).toEqual({ kind: "close-overlay", frameId: "f2" });
  });

  it("reopens a close-overlay", () => {
    const objects = sampleObjects();
    const action = deactivateInteraction(
      {
        "action-type": "close-overlay",
        destination: "f2",
        "overlay-pos-type": "center",
        animation: { "animation-type": "dissolve" },
      },
      objects.s1,
      objects.f1,
      { x: 0, y: 0 },
      readerOf(objects),
      [],
    );
    expect(action).toEqual({
      kind: "open-overlay",
      overlay: {
        frameId: "f2",
        position: { x: 30, y: 35 },
        snapTo: ["center", "center"],
        closeClickOutside: undefined,
        backgroundOverlay: undefined,
        animation: { "animation-type": "dissolve" },
        fixedSource: false,
      },
    });
  });

  it("answers nothing for the actions without an inverse", () => {
    const objects = sampleObjects();
    expect(
      deactivateInteraction(
        { "action-type": "navigate", destination: "f2" },
        objects.s1,
        objects.f1,
        { x: 0, y: 0 },
        readerOf(objects),
        [],
      ),
    ).toBeNull();
  });
});

describe("invertDirection", () => {
  it("flips slide directions pairwise", () => {
    expect(invertDirection({ "animation-type": "slide", direction: "right" })).toEqual({
      "animation-type": "slide",
      direction: "left",
    });
    expect(invertDirection({ "animation-type": "slide", direction: "up" })).toEqual({
      "animation-type": "slide",
      direction: "down",
    });
  });

  it("keeps animations without a direction", () => {
    const dissolve = { "animation-type": "dissolve" as const };
    expect(invertDirection(dissolve)).toBe(dissolve);
    expect(invertDirection(undefined)).toBeUndefined();
  });
});

describe("calculateDelta", () => {
  const size: ViewerSize = {
    baseWidth: 100,
    baseHeight: 100,
    x: 10,
    y: 20,
    width: 200,
    height: 200,
  };

  it("snaps left/top against the bounds origin", () => {
    expect(calculateDelta(size, rect(0, 0, 100, 100), ["top", "left"], 2)).toEqual({
      x: -20,
      y: -40,
    });
  });

  it("snaps right/bottom against the padded edge", () => {
    // delta-x = x2 - (x + width/zoom) = 100 - (10 + 100) = -10 (scaled -20);
    // delta-y = y2 - (y + height/zoom) = 100 - (20 + 100) = -20 (scaled -40).
    expect(calculateDelta(size, rect(0, 0, 100, 100), ["bottom", "right"], 2)).toEqual({
      x: -20,
      y: -40,
    });
  });

  it("centers the selrect inside the padded bounds", () => {
    // (100 - 200/2)/2 - (10 - 0) = -10 (scaled -20). The y side subtracts
    // size.y (20), so it lands at -40.
    expect(calculateDelta(size, rect(0, 0, 100, 100), ["center", "center"], 2)).toEqual({
      x: -20,
      y: -40,
    });
  });
});

describe("calculateWrapper", () => {
  const sizeA: ViewerSize = { baseWidth: 100, baseHeight: 50, x: 0, y: 0, width: 200, height: 100 };
  const sizeB: ViewerSize = { baseWidth: 80, baseHeight: 90, x: 0, y: 0, width: 160, height: 180 };

  it("answers null without sizes", () => {
    expect(calculateWrapper(null, null, 2)).toBeNull();
  });

  it("answers the single size untouched", () => {
    expect(calculateWrapper(sizeA, null, 2)).toEqual({
      width: 200,
      height: 100,
      vbox: "0 0 100 50",
    });
  });

  it("answers the largest base size, zoomed", () => {
    expect(calculateWrapper(sizeA, sizeB, 2)).toEqual({
      width: 200,
      height: 180,
      vbox: "0 0 100 90",
    });
  });
});

// The Point type is re-exported for the callers; keep a reference so the
// import stays meaningful for the type checker.
const ORIGIN: Point = { x: 0, y: 0 };
void ORIGIN;
