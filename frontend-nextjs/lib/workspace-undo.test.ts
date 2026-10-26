// Unit tests for the F9.7 undo stack: the cursor, the inversion of a
// commit into its undo changes and the local application of either
// direction over the JS model. No wasm and no RPC here; the canvas test
// surface is exercised through these pure functions.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import type { UpdateFileChange } from "@/lib/transit";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import {
  applyUpdateChanges,
  canRedo,
  canUndo,
  createUndoState,
  invertChanges,
  pushUndo,
  redoStep,
  UNDO_LIMIT,
  undoStep,
  type UndoEntry,
} from "@/lib/workspace-undo";

const PAGE_ID = "00000000-0000-0000-0000-0000000000a1";
const FRAME_A = "00000000-0000-0000-0000-0000000000a2";
const FRAME_B = "00000000-0000-0000-0000-0000000000a3";
const RECT = "00000000-0000-0000-0000-0000000000a4";

function shape(id: string, parentId: string, extra: Partial<WorkspaceShape> = {}): WorkspaceShape {
  return { id, type: "rect", "parent-id": parentId, "frame-id": parentId, ...extra };
}

function model(): WorkspaceObjects {
  return {
    [ZERO_UUID]: shape(ZERO_UUID, ZERO_UUID, { type: "frame", shapes: [FRAME_A] }),
    [FRAME_A]: shape(FRAME_A, ZERO_UUID, { type: "frame", shapes: [RECT] }),
    [FRAME_B]: shape(FRAME_B, ZERO_UUID, { type: "frame", shapes: [] }),
    [RECT]: shape(RECT, FRAME_A, { x: 10, y: 20, rotation: 0 }),
  };
}

const ITEM_A = "00000000-0000-0000-0000-0000000000b1";
const ITEM_B = "00000000-0000-0000-0000-0000000000b2";
const ITEM_C = "00000000-0000-0000-0000-0000000000b3";
const ITEM_D = "00000000-0000-0000-0000-0000000000b4";
const ITEMS = [ITEM_A, ITEM_B, ITEM_C, ITEM_D];

// A frame with four stacked rects, for the z-order inversions.
function orderedModel(): WorkspaceObjects {
  const objects: WorkspaceObjects = {
    [ZERO_UUID]: shape(ZERO_UUID, ZERO_UUID, { type: "frame", shapes: [FRAME_A] }),
    [FRAME_A]: shape(FRAME_A, ZERO_UUID, { type: "frame", shapes: [...ITEMS] }),
    [FRAME_B]: shape(FRAME_B, ZERO_UUID, { type: "frame", shapes: [] }),
  };
  for (const id of ITEMS) objects[id] = shape(id, FRAME_A);
  return objects;
}

function entry(label: string): UndoEntry {
  return {
    changes: [{ type: "mod-obj", "page-id": PAGE_ID, id: RECT, operations: [] }],
    undoChanges: [{ type: "mod-obj", "page-id": PAGE_ID, id: RECT, operations: [] }],
    selectionBefore: [label],
    selectionAfter: [label],
  };
}

describe("undo cursor", () => {
  it("starts empty and pushes one entry at a time", () => {
    const empty = createUndoState();
    expect(canUndo(empty)).toBe(false);
    expect(canRedo(empty)).toBe(false);
    expect(undoStep(empty)).toBeNull();
    expect(redoStep(empty)).toBeNull();

    const pushed = pushUndo(empty, entry("a"));
    expect(pushed.index).toBe(0);
    expect(canUndo(pushed)).toBe(true);
    expect(canRedo(pushed)).toBe(false);
  });

  it("walks back and forth without dropping entries", () => {
    const state = pushUndo(pushUndo(createUndoState(), entry("a")), entry("b"));

    const undone = undoStep(state);
    expect(undone?.entry.selectionBefore).toEqual(["b"]);
    expect(undone?.state.index).toBe(0);
    expect(canRedo(undone!.state)).toBe(true);

    const undoneAgain = undoStep(undone!.state);
    expect(undoneAgain?.entry.selectionBefore).toEqual(["a"]);
    expect(undoneAgain?.state.index).toBe(-1);
    expect(canUndo(undoneAgain!.state)).toBe(false);

    const redone = redoStep(undoneAgain!.state);
    expect(redone?.entry.selectionBefore).toEqual(["a"]);
    expect(redone?.state.index).toBe(0);
  });

  it("drops the redo branch when a new commit follows an undo", () => {
    const state = pushUndo(pushUndo(createUndoState(), entry("a")), entry("b"));
    const undone = undoStep(state)!.state;
    const pushed = pushUndo(undone, entry("c"));

    expect(pushed.entries.map((item) => item.selectionBefore)).toEqual([["a"], ["c"]]);
    expect(pushed.index).toBe(1);
    expect(canRedo(pushed)).toBe(false);
  });

  it("caps the stack at UNDO_LIMIT and keeps the newest entries", () => {
    let state = createUndoState();
    for (let index = 0; index < UNDO_LIMIT + 5; index += 1) {
      state = pushUndo(state, entry(String(index)));
    }
    expect(state.entries).toHaveLength(UNDO_LIMIT);
    expect(state.entries[0].selectionBefore).toEqual(["5"]);
    expect(state.entries[UNDO_LIMIT - 1].selectionBefore).toEqual([String(UNDO_LIMIT + 4)]);
    expect(state.index).toBe(UNDO_LIMIT - 1);
  });
});

describe("invertChanges", () => {
  it("writes the previous value of every mod-obj attribute", () => {
    const changes: UpdateFileChange[] = [
      {
        type: "mod-obj",
        "page-id": PAGE_ID,
        id: RECT,
        operations: [
          { type: "set", attr: "x", val: 30 },
          { type: "set", attr: "rotation", val: 45 },
        ],
      },
    ];

    expect(invertChanges(model(), changes)).toEqual([
      {
        type: "mod-obj",
        "page-id": PAGE_ID,
        id: RECT,
        operations: [
          { type: "set", attr: "rotation", val: 0 },
          { type: "set", attr: "x", val: 10 },
        ],
      },
    ]);
  });

  it("inverts an attribute the old shape does not carry into a nil set", () => {
    const changes: UpdateFileChange[] = [
      {
        type: "mod-obj",
        "page-id": PAGE_ID,
        id: RECT,
        operations: [{ type: "set", attr: "hide-in-viewer", val: true }],
      },
    ];

    // A nil val reaches the backend as a dissoc (set-shape-attr on nil), so
    // the companion flag disappears again on undo.
    expect(invertChanges(model(), changes)).toEqual([
      {
        type: "mod-obj",
        "page-id": PAGE_ID,
        id: RECT,
        operations: [{ type: "set", attr: "hide-in-viewer", val: null }],
      },
    ]);
  });

  it("turns an add-obj into a del-obj", () => {
    const changes: UpdateFileChange[] = [
      {
        type: "add-obj",
        id: RECT,
        obj: { id: RECT, type: "rect" },
        "page-id": PAGE_ID,
        "frame-id": FRAME_A,
        "parent-id": FRAME_A,
      },
    ];

    expect(invertChanges(model(), changes)).toEqual([
      { type: "del-obj", "page-id": PAGE_ID, id: RECT },
    ]);
  });

  it("inverts every moved shape back to its previous parent position", () => {
    const changes: UpdateFileChange[] = [
      {
        type: "mov-objects",
        "page-id": PAGE_ID,
        "parent-id": FRAME_B,
        shapes: [RECT],
      },
    ];

    expect(invertChanges(model(), changes)).toEqual([
      {
        type: "mov-objects",
        "page-id": PAGE_ID,
        "parent-id": FRAME_A,
        shapes: [RECT],
        index: 0,
      },
    ]);
  });

  it("keeps the old stacking when a commit moved several shapes out", () => {
    const before = orderedModel();
    const changes: UpdateFileChange[] = [
      {
        type: "mov-objects",
        "page-id": PAGE_ID,
        "parent-id": FRAME_B,
        shapes: [ITEM_D, ITEM_B],
      },
    ];

    const inverted = invertChanges(before, changes);
    expect(inverted).toEqual([
      {
        type: "mov-objects",
        "page-id": PAGE_ID,
        "parent-id": FRAME_A,
        shapes: [ITEM_B],
        index: 1,
      },
      {
        type: "mov-objects",
        "page-id": PAGE_ID,
        "parent-id": FRAME_A,
        shapes: [ITEM_D],
        index: 3,
      },
    ]);

    const moved = applyUpdateChanges(before, changes);
    expect(moved[FRAME_A].shapes).toEqual([ITEM_A, ITEM_C]);
    const undone = applyUpdateChanges(moved, inverted);
    expect(undone[FRAME_A].shapes).toEqual(ITEMS);
  });

  it("round-trips a same-parent z-order move", () => {
    const before = orderedModel();
    const changes: UpdateFileChange[] = [
      {
        type: "mov-objects",
        "page-id": PAGE_ID,
        "parent-id": FRAME_A,
        shapes: [ITEM_B],
        index: 3,
      },
    ];

    const reordered = applyUpdateChanges(before, changes);
    expect(reordered[FRAME_A].shapes).toEqual([ITEM_A, ITEM_C, ITEM_B, ITEM_D]);

    const undone = applyUpdateChanges(reordered, invertChanges(before, changes));
    expect(undone[FRAME_A].shapes).toEqual(ITEMS);
  });

  it("walks the changes in reverse so an add-then-modify commit deletes last", () => {
    const changes: UpdateFileChange[] = [
      {
        type: "mod-obj",
        "page-id": PAGE_ID,
        id: RECT,
        operations: [{ type: "set", attr: "x", val: 30 }],
      },
      {
        type: "add-obj",
        id: RECT,
        obj: { id: RECT, type: "rect" },
        "page-id": PAGE_ID,
        "frame-id": FRAME_A,
        "parent-id": FRAME_A,
      },
    ];

    expect(invertChanges(model(), changes).map((change) => change.type)).toEqual([
      "del-obj",
      "mod-obj",
    ]);
  });

  it("refuses to invert a del-obj, which no F9 write produces", () => {
    expect(() =>
      invertChanges(model(), [{ type: "del-obj", "page-id": PAGE_ID, id: RECT }]),
    ).toThrow(/no inverse/);
  });
});

describe("applyUpdateChanges", () => {
  it("merges the mod-obj set operations over the shape", () => {
    const before = model();
    const next = applyUpdateChanges(before, [
      {
        type: "mod-obj",
        "page-id": PAGE_ID,
        id: RECT,
        operations: [
          { type: "set", attr: "x", val: 30 },
          { type: "set", attr: "rotation", val: 45 },
        ],
      },
    ]);

    expect(next[RECT].x).toBe(30);
    expect(next[RECT].rotation).toBe(45);
    expect(next[RECT].y).toBe(20);
    // Untouched shapes keep their reference.
    expect(next[FRAME_A]).toBe(before[FRAME_A]);
  });

  it("deletes an attribute on a nil set and treats a missing one as a no-op", () => {
    const before = model();
    const flagged = applyUpdateChanges(before, [
      {
        type: "mod-obj",
        "page-id": PAGE_ID,
        id: RECT,
        operations: [{ type: "set", attr: "hide-in-viewer", val: true }],
      },
    ]);
    expect(flagged[RECT]["hide-in-viewer"]).toBe(true);

    const cleared = applyUpdateChanges(flagged, [
      {
        type: "mod-obj",
        "page-id": PAGE_ID,
        id: RECT,
        operations: [{ type: "set", attr: "hide-in-viewer", val: null }],
      },
    ]);
    expect("hide-in-viewer" in cleared[RECT]).toBe(false);

    // Removing an attribute the shape never carried changes nothing.
    const untouched = applyUpdateChanges(before, [
      {
        type: "mod-obj",
        "page-id": PAGE_ID,
        id: RECT,
        operations: [{ type: "set", attr: "hide-in-viewer", val: null }],
      },
    ]);
    expect(untouched).toBe(before);
  });

  it("inserts an added shape at the tail of its parent", () => {
    const next = applyUpdateChanges(model(), [
      {
        type: "add-obj",
        id: "00000000-0000-0000-0000-0000000000a5",
        obj: { id: "00000000-0000-0000-0000-0000000000a5", type: "rect" },
        "page-id": PAGE_ID,
        "frame-id": FRAME_B,
        "parent-id": FRAME_B,
      },
    ]);

    const added = "00000000-0000-0000-0000-0000000000a5";
    expect(next[added]["parent-id"]).toBe(FRAME_B);
    expect(next[FRAME_B].shapes).toEqual([added]);
  });

  it("inserts an added shape at the change index", () => {
    const objects = orderedModel();
    const added = "00000000-0000-0000-0000-0000000000a5";
    const next = applyUpdateChanges(objects, [
      {
        type: "add-obj",
        id: added,
        obj: { id: added, type: "rect" },
        "page-id": PAGE_ID,
        "frame-id": FRAME_A,
        "parent-id": FRAME_A,
        index: 1,
      },
    ]);

    expect(next[FRAME_A].shapes).toEqual([ITEM_A, added, ITEM_B, ITEM_C, ITEM_D]);
  });

  it("deletes a subtree and detaches it from the parent", () => {
    const withChild: WorkspaceObjects = {
      ...model(),
      [RECT]: shape(RECT, FRAME_A, { shapes: ["00000000-0000-0000-0000-0000000000a6"] }),
      "00000000-0000-0000-0000-0000000000a6": shape(
        "00000000-0000-0000-0000-0000000000a6",
        RECT,
      ),
    };

    const next = applyUpdateChanges(withChild, [
      { type: "del-obj", "page-id": PAGE_ID, id: RECT },
    ]);

    expect(next[RECT]).toBeUndefined();
    expect(next["00000000-0000-0000-0000-0000000000a6"]).toBeUndefined();
    expect(next[FRAME_A].shapes).toEqual([]);
  });

  it("detaches a root-level shape from the zero root", () => {
    const rootShape = "00000000-0000-0000-0000-0000000000a7";
    const added = applyUpdateChanges(model(), [
      {
        type: "add-obj",
        id: rootShape,
        obj: { id: rootShape, type: "rect" },
        "page-id": PAGE_ID,
        "frame-id": ZERO_UUID,
        "parent-id": ZERO_UUID,
      },
    ]);
    expect(added[ZERO_UUID].shapes).toContain(rootShape);

    const undone = applyUpdateChanges(added, [
      { type: "del-obj", "page-id": PAGE_ID, id: rootShape },
    ]);
    expect(undone[rootShape]).toBeUndefined();
    expect(undone[ZERO_UUID].shapes).not.toContain(rootShape);
  });

  it("re-parents and rewrites the frame-id of the subtree", () => {
    const next = applyUpdateChanges(model(), [
      { type: "mov-objects", "page-id": PAGE_ID, "parent-id": FRAME_B, shapes: [RECT] },
    ]);

    expect(next[RECT]["parent-id"]).toBe(FRAME_B);
    expect(next[RECT]["frame-id"]).toBe(FRAME_B);
    expect(next[FRAME_A].shapes).toEqual([]);
    expect(next[FRAME_B].shapes).toEqual([RECT]);
  });

  it("round-trips a move commit back to the original model", () => {
    const before = model();
    const changes: UpdateFileChange[] = [
      {
        type: "mod-obj",
        "page-id": PAGE_ID,
        id: RECT,
        operations: [
          { type: "set", attr: "x", val: 40 },
          { type: "set", attr: "y", val: 50 },
        ],
      },
      { type: "mov-objects", "page-id": PAGE_ID, "parent-id": FRAME_B, shapes: [RECT] },
    ];

    const moved = applyUpdateChanges(before, changes);
    expect(moved[RECT]["parent-id"]).toBe(FRAME_B);

    const undone = applyUpdateChanges(moved, invertChanges(before, changes));
    expect(undone[RECT]).toEqual(before[RECT]);
    expect(undone[FRAME_A].shapes).toEqual([RECT]);
    expect(undone[FRAME_B].shapes).toEqual([]);
  });

  it("round-trips the relocate companions of a move", () => {
    const before = model();
    const changes: UpdateFileChange[] = [
      {
        type: "mod-obj",
        "page-id": PAGE_ID,
        id: FRAME_A,
        operations: [{ type: "set", attr: "hide-in-viewer", val: true }],
      },
      { type: "mov-objects", "page-id": PAGE_ID, "parent-id": FRAME_B, shapes: [FRAME_A] },
    ];

    const moved = applyUpdateChanges(before, changes);
    expect(moved[FRAME_A]["hide-in-viewer"]).toBe(true);
    expect(moved[ZERO_UUID].shapes).toEqual([]);
    expect(moved[FRAME_B].shapes).toEqual([FRAME_A]);

    const undone = applyUpdateChanges(moved, invertChanges(before, changes));
    expect(undone[FRAME_A]).toEqual(before[FRAME_A]);
    expect(undone[ZERO_UUID].shapes).toEqual([FRAME_A]);
    expect(undone[FRAME_B].shapes).toEqual([]);
  });
});
