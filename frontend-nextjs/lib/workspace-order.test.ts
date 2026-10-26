// Unit tests for the F9.8 z-order slice: the insert-at-index mirror and the
// vertical-order change builder. The builder is compared against the CLJS
// formulas of vertical-order-selected, and the insertion against
// app.common.data/insert-at-index.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import { buildVerticalOrderChanges, insertChildren } from "@/lib/workspace-order";

const PAGE_ID = "00000000-0000-0000-0000-0000000000c1";
const FRAME = "00000000-0000-0000-0000-0000000000c2";
const A = "00000000-0000-0000-0000-0000000000c3";
const B = "00000000-0000-0000-0000-0000000000c4";
const C = "00000000-0000-0000-0000-0000000000c5";
const D = "00000000-0000-0000-0000-0000000000c6";
const X = "00000000-0000-0000-0000-0000000000c7";

function shape(id: string, parentId: string, extra: Partial<WorkspaceShape> = {}): WorkspaceShape {
  return { id, type: "rect", "parent-id": parentId, "frame-id": parentId, ...extra };
}

function model(): WorkspaceObjects {
  return {
    [ZERO_UUID]: shape(ZERO_UUID, ZERO_UUID, { type: "frame", shapes: [FRAME] }),
    [FRAME]: shape(FRAME, ZERO_UUID, { type: "frame", shapes: [A, B, C, D] }),
    [A]: shape(A, FRAME),
    [B]: shape(B, FRAME),
    [C]: shape(C, FRAME),
    [D]: shape(D, FRAME),
  };
}

describe("insertChildren", () => {
  it("inserts at the bottom, the tail and a middle index", () => {
    expect(insertChildren([A, B, C], 0, [X])).toEqual([X, A, B, C]);
    expect(insertChildren([A, B, C], 3, [X])).toEqual([A, B, C, X]);
    expect(insertChildren([A, B, C], 1, [X])).toEqual([A, X, B, C]);
  });

  it("clamps out-of-range indexes like split-at", () => {
    expect(insertChildren([A, B, C], -4, [X])).toEqual([X, A, B, C]);
    expect(insertChildren([A, B, C], 99, [X])).toEqual([A, B, C, X]);
    expect(insertChildren([], 5, [X])).toEqual([X]);
  });

  it("re-indexes a shape already in the list from the pre-move snapshot", () => {
    // up from the middle: the split at 3 keeps [A, B, C], B drops out of
    // the before half and the incoming B lands after C.
    expect(insertChildren([A, B, C, D], 3, [B])).toEqual([A, C, B, D]);
    // down from the bottom is a no-op.
    expect(insertChildren([A, B, C, D], 0, [A])).toEqual([A, B, C, D]);
    // re-inserting at the current index keeps the order.
    expect(insertChildren([A, B, C], 1, [B])).toEqual([A, B, C]);
  });

  it("takes the incoming ids as a block and removes them from both halves", () => {
    expect(insertChildren([A, B, C, D], 2, [D, B])).toEqual([A, D, B, C]);
    expect(insertChildren([A, B, C, D], 0, [C, A])).toEqual([C, A, B, D]);
  });
});

describe("buildVerticalOrderChanges", () => {
  it("sends :top past the last sibling", () => {
    const changes = buildVerticalOrderChanges(model(), [A], "top", PAGE_ID);
    expect(changes).toEqual([
      {
        type: "mov-objects",
        "page-id": PAGE_ID,
        "parent-id": FRAME,
        shapes: [A],
        index: 4,
      },
    ]);
  });

  it("uses the current index + 2 for :up and the -1 clamp for :down", () => {
    expect(buildVerticalOrderChanges(model(), [B], "up", PAGE_ID)[0].index).toBe(3);
    expect(buildVerticalOrderChanges(model(), [D], "up", PAGE_ID)[0].index).toBe(4);
    expect(buildVerticalOrderChanges(model(), [C], "down", PAGE_ID)[0].index).toBe(1);
    expect(buildVerticalOrderChanges(model(), [A], "down", PAGE_ID)[0].index).toBe(0);
  });

  it("uses the position inside the selection for :bottom", () => {
    const changes = buildVerticalOrderChanges(model(), [C, B], "bottom", PAGE_ID);
    expect(changes.map((change) => [change.shapes, change.index])).toEqual([
      [[C], 0],
      [[B], 1],
    ]);
  });

  it("emits one change per shape in selection order, deduplicated", () => {
    const changes = buildVerticalOrderChanges(model(), [D, B, D], "top", PAGE_ID);
    expect(changes.map((change) => change.shapes)).toEqual([[D], [B]]);
    expect(changes.every((change) => change["parent-id"] === FRAME)).toBe(true);
  });

  it("skips shapes and parents missing from the model", () => {
    const orphan = "00000000-0000-0000-0000-0000000000c8";
    const noParent = "00000000-0000-0000-0000-0000000000c9";
    const objects: WorkspaceObjects = {
      ...model(),
      [noParent]: shape(noParent, "00000000-0000-0000-0000-0000000000cf"),
    };
    expect(buildVerticalOrderChanges(objects, [orphan], "top", PAGE_ID)).toEqual([]);
    expect(buildVerticalOrderChanges(objects, [noParent], "top", PAGE_ID)).toEqual([]);
    expect(buildVerticalOrderChanges(objects, [], "top", PAGE_ID)).toEqual([]);
  });
});
