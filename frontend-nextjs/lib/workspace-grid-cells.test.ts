// Unit tests for the grid cell model (lib/workspace-grid-cells): the cell
// map read and write, the partition invariant, the track removal, the three
// placement paths and the panel values. The module is pure and every test
// injects its own id factory, so the expectations stay stable.

import { describe, expect, it } from "vitest";

import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import {
  assignCells,
  assignGrid,
  autoShape,
  cellsMap,
  cellWire,
  flowChildIds,
  gridCellValues,
  gridCellsOf,
  gridPlacementEdit,
  gridSelfEdit,
  gridStatePatch,
  gridTrackEdit,
  normalizeCells,
  placeShape,
  removeTrackAt,
  type GridCell,
} from "@/lib/workspace-grid-cells";
import { isPositionAbsolute } from "@/lib/workspace-layout";

function shape(id: string, attrs: Record<string, unknown> = {}): WorkspaceShape {
  return { id, type: "rect", ...attrs };
}

function grid(attrs: Record<string, unknown> = {}): WorkspaceShape {
  return shape("grid-1", { type: "frame", layout: "grid", ...attrs });
}

function child(id: string, attrs: Record<string, unknown> = {}): WorkspaceShape {
  return shape(id, { "parent-id": "grid-1", ...attrs });
}

// A cell record as the file stores it (wire keys, kebab-case).
function wireCell(
  id: string,
  row: number,
  column: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    row,
    "row-span": 1,
    column,
    "column-span": 1,
    position: "auto",
    "align-self": "auto",
    "justify-self": "auto",
    shapes: [],
    ...extra,
  };
}

// Disjoint 1x1 cells, the shape normalizeCells builds over empty tracks.
function cellsOf(
  rows: number,
  columns: number,
  ids: string[] = [],
): GridCell[] {
  return normalizeCells([], rows, columns, () => ids.shift() ?? "unused");
}

function ids(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `cell-${next}`;
  };
}

function cellAt(cells: readonly GridCell[], row: number, column: number): GridCell | undefined {
  return cells.find((cell) => cell.row === row && cell.column === column);
}

describe("gridCellsOf", () => {
  it("reads the stored map in row major order and drops junk entries", () => {
    const parent = grid({
      "layout-grid-cells": {
        later: wireCell("later", 2, 1),
        first: wireCell("first", 1, 2),
        before: wireCell("before", 1, 1),
        empty: { row: 1, column: 1 },
        text: "not a cell",
      },
    });
    expect(gridCellsOf(parent).map((cell) => cell.id)).toEqual([
      "before",
      "first",
      "later",
    ]);
    expect(gridCellsOf(null)).toEqual([]);
    expect(gridCellsOf(grid())).toEqual([]);
  });

  it("clamps a hand edited record to the schema defaults", () => {
    const parent = grid({
      "layout-grid-cells": {
        cell: {
          ...wireCell("cell", 0, -2),
          "row-span": 0,
          position: "nope",
          "align-self": "middle",
          "justify-self": "center",
          shapes: ["a", 7, "b"],
        },
      },
    });
    expect(gridCellsOf(parent)[0]).toEqual({
      id: "cell",
      row: 1,
      rowSpan: 1,
      column: 1,
      columnSpan: 1,
      position: "auto",
      alignSelf: "auto",
      justifySelf: "center",
      areaName: null,
      shapes: ["a", "b"],
    });
  });
});

describe("cellWire", () => {
  it("writes the record keys and skips an empty area name", () => {
    const cell: GridCell = {
      id: "cell-1",
      row: 2,
      rowSpan: 2,
      column: 3,
      columnSpan: 4,
      position: "manual",
      alignSelf: "center",
      justifySelf: "end",
      areaName: null,
      shapes: ["a"],
    };
    expect(cellWire(cell)).toEqual({
      id: "cell-1",
      row: 2,
      "row-span": 2,
      column: 3,
      "column-span": 4,
      position: "manual",
      "align-self": "center",
      "justify-self": "end",
      shapes: ["a"],
    });
    expect(cellWire({ ...cell, areaName: "header" })["area-name"]).toBe("header");
  });

  it("keys the map by the cell id", () => {
    const map = cellsMap([cellOf({ id: "cell-1" }), cellOf({ id: "cell-2" })]);
    expect(Object.keys(map)).toEqual(["cell-1", "cell-2"]);
    expect(map["cell-1"]).toMatchObject({ id: "cell-1" });
  });
});

function cellOf(attrs: Partial<GridCell>): GridCell {
  return {
    id: "cell-1",
    row: 1,
    rowSpan: 1,
    column: 1,
    columnSpan: 1,
    position: "auto",
    alignSelf: "auto",
    justifySelf: "auto",
    areaName: null,
    shapes: [],
    ...attrs,
  };
}

describe("normalizeCells", () => {
  it("fills every intersection of an empty grid", () => {
    let next = 0;
    const cells = normalizeCells([], 2, 3, () => `new-${(next += 1)}`);
    expect(cells).toHaveLength(6);
    expect(cells.map((cell) => `${cell.row}:${cell.column}`)).toEqual([
      "1:1",
      "1:2",
      "1:3",
      "2:1",
      "2:2",
      "2:3",
    ]);
    expect(cells[0]).toEqual(cellOf({ id: "new-1" }));
  });

  it("clips a span that runs past the tracks and drops a cell outside", () => {
    const cells = normalizeCells(
      [
        cellOf({ id: "big", row: 3, rowSpan: 5, column: 2, columnSpan: 2 }),
        cellOf({ id: "outside", row: 9, column: 1 }),
      ],
      4,
      2,
      () => "new",
    );
    expect(cells.find((cell) => cell.id === "big")).toMatchObject({
      row: 3,
      rowSpan: 2,
      column: 2,
      columnSpan: 1,
    });
    expect(cells.some((cell) => cell.id === "outside")).toBe(false);
  });

  it("covers only the intersections a spanning cell leaves free", () => {
    const cells = normalizeCells(
      [cellOf({ id: "wide", row: 1, column: 1, columnSpan: 2, position: "manual" })],
      2,
      2,
      () => "new",
    );
    expect(cells).toHaveLength(3);
    expect(cells.filter((cell) => cell.id === "wide")).toHaveLength(1);
    expect(cells.map((cell) => `${cell.row}:${cell.column}`)).toEqual([
      "1:1",
      "2:1",
      "2:2",
    ]);
  });

  it("has no cells without tracks", () => {
    expect(normalizeCells([cellOf({})], 0, 2, () => "new")).toEqual([]);
    expect(normalizeCells([], 2, 0, () => "new")).toEqual([]);
  });
});

describe("removeTrackAt", () => {
  const cells = [
    cellOf({ id: "first", row: 1, column: 1 }),
    cellOf({ id: "second", row: 2, column: 1 }),
    cellOf({ id: "third", row: 3, column: 1 }),
    cellOf({ id: "tall", row: 1, rowSpan: 3, column: 2 }),
  ];

  it("drops the cells on the removed line and shifts the rest back", () => {
    const out = removeTrackAt(cells, "rows", 0);
    expect(out.map((cell) => cell.id)).toEqual(["second", "third", "tall"]);
    expect(out.map((cell) => cell.row)).toEqual([1, 2, 1]);
    expect(out.find((cell) => cell.id === "tall")?.rowSpan).toBe(2);
  });

  it("keeps the cells before the line untouched", () => {
    const out = removeTrackAt(cells, "rows", 2);
    expect(out.find((cell) => cell.id === "first")?.row).toBe(1);
    expect(out.find((cell) => cell.id === "second")?.row).toBe(2);
    expect(out.some((cell) => cell.id === "third")).toBe(false);
    expect(out.find((cell) => cell.id === "tall")?.rowSpan).toBe(2);
  });

  it("shrinks the span when the line sits inside it", () => {
    const out = removeTrackAt(cells, "rows", 1);
    const tall = out.find((cell) => cell.id === "tall");
    expect(tall).toMatchObject({ row: 1, rowSpan: 2 });
    expect(out.map((cell) => cell.id)).toEqual(["first", "third", "tall"]);
    expect(out.find((cell) => cell.id === "third")?.row).toBe(2);
  });

  it("works on the column axis", () => {
    const out = removeTrackAt(
      [
        cellOf({ id: "a", column: 1 }),
        cellOf({ id: "b", column: 2 }),
        cellOf({ id: "wide", column: 1, columnSpan: 2 }),
      ],
      "columns",
      0,
    );
    expect(out.map((cell) => cell.id)).toEqual(["b", "wide"]);
    expect(out.find((cell) => cell.id === "b")?.column).toBe(1);
    expect(out.find((cell) => cell.id === "wide")?.columnSpan).toBe(1);
  });
});

describe("placeShape", () => {
  it("reuses the cell it starts on and drops the covered area", () => {
    const cells = [
      cellOf({ id: "target", row: 1, column: 1, alignSelf: "center", shapes: ["old"] }),
      cellOf({ id: "right", row: 1, column: 2 }),
      cellOf({ id: "below", row: 2, column: 1 }),
    ];
    const out = placeShape(cells, "shape-1", {
      row: 1,
      column: 1,
      rowSpan: 1,
      columnSpan: 2,
    });
    // The cell below the area stays; the covered neighbours go away.
    expect(out.map((cell) => cell.id)).toEqual(["target", "below"]);
    expect(out[0]).toMatchObject({
      row: 1,
      column: 1,
      rowSpan: 1,
      columnSpan: 2,
      position: "manual",
      alignSelf: "center",
      shapes: ["shape-1"],
    });
  });

  it("frees the cells the shape leaves and creates the target cell", () => {
    const cells = [
      cellOf({ id: "old", row: 1, column: 1, shapes: ["shape-1"] }),
      cellOf({ id: "other", row: 1, column: 2 }),
    ];
    const out = placeShape(
      cells,
      "shape-1",
      { row: 2, column: 2, rowSpan: 2, columnSpan: 1 },
      () => "new",
    );
    expect(out.map((cell) => cell.id).sort()).toEqual(["new", "old", "other"].sort());
    expect(out.find((cell) => cell.id === "old")?.shapes).toEqual([]);
    expect(out.find((cell) => cell.id === "new")).toMatchObject({
      row: 2,
      column: 2,
      rowSpan: 2,
      columnSpan: 1,
      position: "manual",
      shapes: ["shape-1"],
    });
  });
});

describe("autoShape", () => {
  it("releases the span of the cell the shape leaves", () => {
    const cells = normalizeCells(
      [cellOf({ id: "wide", row: 1, column: 1, columnSpan: 2, position: "manual", shapes: ["shape-1"] })],
      1,
      2,
      () => "new",
    );
    const out = autoShape(cells, "shape-1", 1, 2, () => "new");
    const own = out.find((cell) => cell.id === "wide");
    expect(own).toMatchObject({
      rowSpan: 1,
      columnSpan: 1,
      position: "auto",
      shapes: [],
    });
    expect(out).toHaveLength(2);
    expect(cellAt(out, 1, 2)?.shapes).toEqual([]);
  });

  it("leaves the other cells alone", () => {
    const cells = [
      cellOf({ id: "mine", row: 1, column: 1, shapes: ["shape-1"] }),
      cellOf({ id: "theirs", row: 1, column: 2, shapes: ["shape-2"] }),
    ];
    const out = autoShape(cells, "shape-1", 1, 2, () => "new");
    expect(out.find((cell) => cell.id === "theirs")?.shapes).toEqual(["shape-2"]);
  });
});

describe("assignCells", () => {
  it("places the orphans in reading order and grows the columns of a row grid", () => {
    const result = assignCells({
      cells: [],
      children: ["a", "b", "c"],
      rows: 1,
      columns: 1,
      direction: "row",
      nextId: ids(),
    });
    expect(result.rows).toBe(1);
    expect(result.columns).toBe(3);
    expect(result.cells.map((cell) => cell.shapes[0])).toEqual(["a", "b", "c"]);
  });

  it("grows the rows of a column grid", () => {
    const result = assignCells({
      cells: [],
      children: ["a", "b"],
      rows: 1,
      columns: 1,
      direction: "column",
      nextId: ids(),
    });
    expect(result.rows).toBe(2);
    expect(result.columns).toBe(1);
    expect(result.cells.map((cell) => cell.shapes[0])).toEqual(["a", "b"]);
  });

  it("starts the 1x1 grid the first orphan needs", () => {
    const result = assignCells({
      cells: [],
      children: ["a"],
      rows: 0,
      columns: 0,
      direction: "row",
      nextId: ids(),
    });
    expect(result).toMatchObject({ rows: 1, columns: 1 });
    expect(result.cells).toHaveLength(1);
  });

  it("skips the absolute children and the shapes that left", () => {
    const result = assignCells({
      cells: [cellOf({ id: "stale", shapes: ["ghost"] })],
      children: ["a", "b"],
      absolute: new Set(["b"]),
      rows: 1,
      columns: 1,
      direction: "row",
      nextId: ids(),
    });
    expect(result.cells.map((cell) => cell.shapes[0])).toEqual(["a"]);
    expect(result.cells.some((cell) => cell.shapes.includes("ghost"))).toBe(false);
    expect(result.cells.some((cell) => cell.shapes.includes("b"))).toBe(false);
  });

  it("keeps a shape in one cell only", () => {
    const result = assignCells({
      cells: [
        cellOf({ id: "first", shapes: ["a"] }),
        cellOf({ id: "second", row: 2, shapes: ["a"] }),
      ],
      children: ["a"],
      rows: 2,
      columns: 1,
      direction: "row",
      nextId: ids(),
    });
    expect(result.cells.filter((cell) => cell.shapes.includes("a"))).toHaveLength(1);
    expect(result.cells.find((cell) => cell.id === "second")?.shapes).toEqual([]);
  });

  it("keeps a placed manual cell as it is", () => {
    const result = assignCells({
      cells: [cellOf({ id: "manual", row: 2, rowSpan: 2, position: "manual", shapes: ["a"] })],
      children: ["a"],
      rows: 3,
      columns: 1,
      direction: "row",
      nextId: ids(),
    });
    expect(result.cells.find((cell) => cell.id === "manual")).toMatchObject({
      row: 2,
      rowSpan: 2,
      position: "manual",
      shapes: ["a"],
    });
  });
});

describe("flowChildIds", () => {
  it("keeps the layer order minus the absolute and the missing children", () => {
    const parent = grid({ shapes: ["a", "b", "c", "d"] });
    const objects: WorkspaceObjects = {
      a: child("a"),
      b: child("b", { "layout-item-absolute": true }),
      c: child("c", { hidden: true }),
    };
    expect(isPositionAbsolute(objects.b)).toBe(true);
    expect(flowChildIds(parent, objects)).toEqual(["a"]);
  });
});

describe("assignGrid", () => {
  it("creates the default tracks the children need", () => {
    const objects: WorkspaceObjects = { a: child("a"), b: child("b") };
    const state = assignGrid(grid({ shapes: ["a", "b"] }), objects, ids());
    expect(state.rows).toEqual([{ type: "flex", value: 1 }]);
    expect(state.columns).toHaveLength(2);
    expect(state.cells.map((cell) => cell.shapes[0])).toEqual(["a", "b"]);
  });

  it("adds one new cell per appended track", () => {
    const objects: WorkspaceObjects = { a: child("a") };
    const parent = grid({
      shapes: ["a"],
      "layout-grid-rows": [{ type: "flex", value: 1 }],
      "layout-grid-columns": [{ type: "flex", value: 1 }],
    });
    const first = assignGrid(parent, objects, ids());
    const widened = assignGrid(
      { ...parent, "layout-grid-columns": [{ type: "flex", value: 1 }, { type: "fixed", value: 40 }] },
      objects,
      ids(),
    );
    expect(first.cells).toHaveLength(1);
    expect(widened.cells).toHaveLength(2);
    expect(widened.cells.filter((cell) => cell.shapes.includes("a"))).toHaveLength(1);
    expect(widened.cells.filter((cell) => cell.shapes.length === 0)).toHaveLength(1);
  });
});

describe("gridTrackEdit", () => {
  it("appends a row without moving the placed child", () => {
    const objects: WorkspaceObjects = { a: child("a") };
    const parent = grid({
      shapes: ["a"],
      "layout-grid-rows": [{ type: "flex", value: 1 }],
      "layout-grid-columns": [{ type: "flex", value: 1 }],
      "layout-grid-cells": { cell: wireCell("cell", 1, 1, { shapes: ["a"] }) },
    });
    const state = gridTrackEdit(
      parent,
      objects,
      "rows",
      [{ type: "flex", value: 1 }, { type: "fixed", value: 40 }],
      null,
      ids(),
    );
    expect(state.rows).toHaveLength(2);
    expect(state.cells).toHaveLength(2);
    expect(state.cells.find((cell) => cell.shapes.includes("a"))).toMatchObject({
      row: 1,
      column: 1,
    });
  });

  it("removes a line and keeps the child placed", () => {
    const objects: WorkspaceObjects = { a: child("a") };
    const parent = grid({
      shapes: ["a"],
      "layout-grid-rows": [{ type: "flex", value: 1 }, { type: "flex", value: 1 }],
      "layout-grid-columns": [{ type: "flex", value: 1 }],
      "layout-grid-cells": {
        first: wireCell("first", 1, 1, { shapes: ["a"] }),
        second: wireCell("second", 2, 1),
      },
    });
    const state = gridTrackEdit(
      parent,
      objects,
      "rows",
      [{ type: "flex", value: 1 }],
      0,
      ids(),
    );
    expect(state.rows).toHaveLength(1);
    expect(state.cells).toHaveLength(1);
    expect(state.cells[0]).toMatchObject({ row: 1, column: 1, shapes: ["a"] });
  });
});

describe("gridPlacementEdit", () => {
  it("pins the child to a rectangle and grows the tracks it needs", () => {
    const objects: WorkspaceObjects = { a: child("a") };
    const parent = grid({
      shapes: ["a"],
      "layout-grid-rows": [{ type: "flex", value: 1 }],
      "layout-grid-columns": [{ type: "flex", value: 1 }],
      "layout-grid-cells": { cell: wireCell("cell", 1, 1, { shapes: ["a"] }) },
    });
    const state = gridPlacementEdit(
      parent,
      objects,
      "a",
      { mode: "manual", row: 3, column: 2, rowSpan: 1, columnSpan: 2 },
      ids(),
    );
    expect(state.rows).toHaveLength(3);
    expect(state.columns).toHaveLength(3);
    expect(state.cells.find((cell) => cell.shapes.includes("a"))).toMatchObject({
      row: 3,
      column: 2,
      rowSpan: 1,
      columnSpan: 2,
      position: "manual",
    });
  });

  it("clamps a non positive rectangle to the first track", () => {
    const objects: WorkspaceObjects = { a: child("a") };
    const parent = grid({
      shapes: ["a"],
      "layout-grid-rows": [{ type: "flex", value: 1 }],
      "layout-grid-columns": [{ type: "flex", value: 1 }],
    });
    const state = gridPlacementEdit(
      parent,
      objects,
      "a",
      { mode: "manual", row: 0, column: 0, rowSpan: 0, columnSpan: 0 },
      ids(),
    );
    expect(state.cells.find((cell) => cell.shapes.includes("a"))).toMatchObject({
      row: 1,
      column: 1,
      rowSpan: 1,
      columnSpan: 1,
    });
  });

  it("returns the child to the flow and releases its span", () => {
    const objects: WorkspaceObjects = { a: child("a") };
    const parent = grid({
      shapes: ["a"],
      "layout-grid-rows": [{ type: "flex", value: 1 }],
      "layout-grid-columns": [{ type: "flex", value: 1 }, { type: "flex", value: 1 }],
      "layout-grid-cells": {
        wide: wireCell("wide", 1, 1, {
          "column-span": 2,
          position: "manual",
          shapes: ["a"],
        }),
      },
    });
    const state = gridPlacementEdit(parent, objects, "a", { mode: "auto" }, ids());
    expect(state.cells.find((cell) => cell.shapes.includes("a"))).toMatchObject({
      position: "auto",
      rowSpan: 1,
      columnSpan: 1,
    });
    expect(state.cells).toHaveLength(2);
  });

  it("places a child that no cell names before the edit", () => {
    const objects: WorkspaceObjects = { a: child("a") };
    const parent = grid({
      shapes: ["a"],
      "layout-grid-rows": [{ type: "flex", value: 1 }],
      "layout-grid-columns": [{ type: "flex", value: 1 }],
    });
    expect(gridCellsOf(parent)).toEqual([]);
    const state = gridPlacementEdit(parent, objects, "a", { mode: "auto" }, ids());
    expect(state.cells.find((cell) => cell.shapes.includes("a"))).toBeDefined();
  });
});

describe("gridSelfEdit", () => {
  const parent = grid({
    shapes: ["a", "b"],
    "layout-grid-rows": [{ type: "flex", value: 1 }],
    "layout-grid-columns": [{ type: "flex", value: 1 }, { type: "flex", value: 1 }],
  });
  const objects: WorkspaceObjects = { a: child("a"), b: child("b") };

  it("places the child first, then writes the alignment", () => {
    const state = gridSelfEdit(parent, objects, "a", { alignSelf: "center" }, ids());
    const own = state.cells.find((cell) => cell.shapes.includes("a"));
    expect(own).toMatchObject({ alignSelf: "center", justifySelf: "auto" });
    expect(state.cells.find((cell) => cell.shapes.includes("b"))).toBeDefined();
  });

  it("writes one axis without touching the other", () => {
    const state = gridSelfEdit(parent, objects, "a", { justifySelf: "end" }, ids());
    expect(state.cells.find((cell) => cell.shapes.includes("a"))).toMatchObject({
      alignSelf: "auto",
      justifySelf: "end",
    });
  });

  it("resets to auto on a null", () => {
    const placed = gridSelfEdit(
      parent,
      objects,
      "a",
      { alignSelf: "center", justifySelf: "center" },
      ids(),
    );
    const state = gridSelfEdit(
      { ...parent, "layout-grid-cells": cellsMap(placed.cells) },
      objects,
      "a",
      { alignSelf: null, justifySelf: null },
      ids(),
    );
    expect(state.cells.find((cell) => cell.shapes.includes("a"))).toMatchObject({
      alignSelf: "auto",
      justifySelf: "auto",
    });
  });

  it("leaves the other children alone", () => {
    const placed = gridSelfEdit(parent, objects, "a", { alignSelf: "center" }, ids());
    const before = gridSelfEdit(parent, objects, "b", { alignSelf: "end" }, ids());
    expect(before.cells.find((cell) => cell.shapes.includes("b"))?.alignSelf).toBe("end");
    expect(placed.cells.find((cell) => cell.shapes.includes("b"))?.alignSelf).toBe("auto");
  });
});

describe("gridStatePatch", () => {
  const parent = grid({
    "layout-grid-rows": [{ type: "flex", value: 1 }],
    "layout-grid-columns": [{ type: "flex", value: 1 }],
  });
  const state = {
    rows: [{ type: "flex" as const, value: 1 }],
    columns: [{ type: "flex" as const, value: 1 }],
    cells: cellsOf(1, 1, ["cell-1"]),
  };

  it("sends only the cell map when the track lengths match", () => {
    const patch = gridStatePatch(state, parent);
    expect(Object.keys(patch)).toEqual(["layout-grid-cells"]);
  });

  it("sends a track list that changed length", () => {
    const patch = gridStatePatch(
      { ...state, rows: [...state.rows, { type: "flex", value: 1 }] },
      parent,
    );
    expect(Object.keys(patch).sort()).toEqual(["layout-grid-cells", "layout-grid-rows"]);
  });

  it("sends both lists on a track edit, even when the lengths match", () => {
    const patch = gridStatePatch(
      { ...state, rows: [{ type: "fixed", value: 40 }] },
      parent,
      true,
    );
    expect(patch["layout-grid-rows"]).toEqual([{ type: "fixed", value: 40 }]);
    expect(patch["layout-grid-columns"]).toEqual([{ type: "flex", value: 1 }]);
  });

  it("sends both lists without a parent to compare", () => {
    const patch = gridStatePatch(state, null);
    expect(Object.keys(patch).sort()).toEqual([
      "layout-grid-cells",
      "layout-grid-columns",
      "layout-grid-rows",
    ]);
  });
});

describe("gridCellValues", () => {
  it("reports a child without a cell", () => {
    expect(gridCellValues(grid(), "a")).toEqual({
      inCell: false,
      mode: "auto",
      row: 1,
      column: 1,
      rowSpan: 1,
      columnSpan: 1,
      alignSelf: "auto",
      justifySelf: "auto",
    });
    expect(gridCellValues(null, "a").inCell).toBe(false);
  });

  it("reports a plain auto cell", () => {
    const parent = grid({
      "layout-grid-cells": { cell: wireCell("cell", 2, 3, { shapes: ["a"] }) },
    });
    expect(gridCellValues(parent, "a")).toMatchObject({
      inCell: true,
      mode: "auto",
      row: 2,
      column: 3,
      rowSpan: 1,
      columnSpan: 1,
    });
  });

  it("reports a span or an area cell as manual", () => {
    const spanned = grid({
      "layout-grid-cells": {
        cell: wireCell("cell", 1, 1, { "row-span": 2, shapes: ["a"] }),
      },
    });
    expect(gridCellValues(spanned, "a").mode).toBe("manual");

    const area = grid({
      "layout-grid-cells": {
        cell: wireCell("cell", 1, 1, { position: "area", shapes: ["a"] }),
      },
    });
    expect(gridCellValues(area, "a").mode).toBe("manual");
  });
});
