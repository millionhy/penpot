// Grid cells of a grid layout (F9.12).
//
// Ported from common/src/app/common/types/shape/layout.cljc:
// schema:grid-cell, grid-cell-defaults, cells-seq, get-free-cells,
// check-deassigned-cells, assign-cells, free-cell-shapes, create-cells,
// get-cell-by-shape-id and get-cell-by-position; and from
// frontend/src/app/main/ui/workspace/sidebar/options/menus/grid_cell.cljs:
// the cell menu (mode, coordinates, self alignment).
//
// Why the shell owns the cell map: render-wasm places only the children that
// appear in `layout-grid-cells` (modifiers/grid_layout.rs create_cell_data
// skips every other child), and the backend applies a mod-obj as-is, without
// running assign-cells (changes.cljc process-operations). So a grid without
// cells places nothing, and every cell edit is a client-side map write on the
// layout frame.
//
// The model is a partition: one cell per intersection of the track grid,
// except the intersections a spanning cell covers. Every write here restores
// that invariant through normalizeCells, which is also what keeps the wasm
// side happy (it drops a cell whose row/column span runs past the tracks).
//
// Deviations from the CLJS original, documented:
// - assign-cells also re-flows the shapes already in auto cells
//   (position-auto-shapes) so their order follows the layer order. Here a
//   shape that already has a cell keeps it; only the orphans are placed, in
//   layer order, into the free auto cells. Moving one child therefore never
//   shuffles the others.
// - resize-cell-area is replaced by a rectangle write: every cell that
//   intersects the new area is dropped and the area becomes one cell. The
//   CLJS splits and clips the neighbours instead, which needs the grid area
//   geometry (common/geom/shapes/grid_areas.cljc).
// - add-grid-track can insert at an index and splits the spanning cells of
//   that line; the panel only appends, so only the append path is here
//   (normalizeCells creates the new cells). removeTrackAt shrinks a spanning
//   cell instead of splitting it.
// - The "area" mode (a named multi cell) is not ported: the panel offers auto
//   and manual, and an area cell read from a file keeps its coordinates but
//   is offered as manual.
//
// Kept free of JSX and of the CLJS runtime so vitest exercises every branch.

import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import { isPositionAbsolute } from "@/lib/workspace-layout";
import {
  defaultTrack,
  layoutValues,
  type GridTrack,
} from "@/lib/workspace-layout-attrs";

export type CellPosition = "auto" | "manual" | "area";

// layout.cljc grid-cell-justify-self-types and grid-cell-align-self-types.
export const GRID_SELF = ["auto", "start", "center", "end", "stretch"] as const;
export type GridSelf = (typeof GRID_SELF)[number];

export type Axis = "rows" | "columns";

// schema:grid-cell. The keys stay camelCase in TS and turn into the record's
// row-span / column-span keys on the wire (see cellWire).
export interface GridCell {
  id: string;
  row: number;
  rowSpan: number;
  column: number;
  columnSpan: number;
  position: CellPosition;
  alignSelf: GridSelf;
  justifySelf: GridSelf;
  areaName: string | null;
  shapes: string[];
}

// The tracks and the cells of one grid, the unit every write returns.
export interface GridState {
  rows: GridTrack[];
  columns: GridTrack[];
  cells: GridCell[];
}

// The cell map the panel shows for one child.
export interface GridCellValues {
  // False when the child has no cell yet (a grid created before F9.12, or a
  // frame whose children arrived with the layout).
  inCell: boolean;
  mode: "auto" | "manual";
  row: number;
  column: number;
  rowSpan: number;
  columnSpan: number;
  alignSelf: GridSelf;
  justifySelf: GridSelf;
}

export type GridPlacement =
  | { mode: "auto" }
  | {
      mode: "manual";
      row: number;
      column: number;
      rowSpan: number;
      columnSpan: number;
    };

export interface CellSelf {
  alignSelf?: GridSelf | null;
  justifySelf?: GridSelf | null;
}

export type IdFactory = () => string;

// crypto.randomUUID exists in the browser (the panel) and in Node 19+ (the
// tests inject their own factory anyway).
export const nextCellId: IdFactory = () => crypto.randomUUID();

const POSITIONS: readonly string[] = ["auto", "manual", "area"];

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function selfOf(value: unknown): GridSelf {
  const text = stringOr(value, "auto");
  return (GRID_SELF as readonly string[]).includes(text) ? (text as GridSelf) : "auto";
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

// One stored cell; an unreadable entry reads as a 1x1 auto cell so a hand
// edited record cannot break the placement.
function cellOf(value: unknown): GridCell | null {
  const record = recordOf(value);
  if (record === null) return null;
  const id = stringOr(record["id"], "");
  if (id === "") return null;
  const position = stringOr(record["position"], "auto");
  const shapes = Array.isArray(record["shapes"])
    ? record["shapes"].filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    id,
    row: Math.max(1, Math.trunc(numberOr(record["row"], 1))),
    rowSpan: Math.max(1, Math.trunc(numberOr(record["row-span"], 1))),
    column: Math.max(1, Math.trunc(numberOr(record["column"], 1))),
    columnSpan: Math.max(1, Math.trunc(numberOr(record["column-span"], 1))),
    position: POSITIONS.includes(position) ? (position as CellPosition) : "auto",
    alignSelf: selfOf(record["align-self"]),
    justifySelf: selfOf(record["justify-self"]),
    areaName: optionalString(record["area-name"]),
    shapes,
  };
}

// Reading order of cells-seq: row major for a row grid, column major for a
// column grid; the id breaks the tie so the order is stable.
function sortCells(cells: readonly GridCell[], direction: string): GridCell[] {
  const column = direction === "column";
  return [...cells].sort((left, right) => {
    const first = column ? left.column - right.column : left.row - right.row;
    if (first !== 0) return first;
    const second = column ? left.row - right.row : left.column - right.column;
    if (second !== 0) return second;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });
}

// cells-seq over the stored map.
export function gridCellsOf(shape: WorkspaceShape | null): GridCell[] {
  if (shape === null) return [];
  const map = recordOf(shape["layout-grid-cells"]);
  if (map === null) return [];
  const cells: GridCell[] = [];
  for (const value of Object.values(map)) {
    const cell = cellOf(value);
    if (cell !== null) cells.push(cell);
  }
  return sortCells(cells, "row");
}

// One cell as the record carries it. The enum values are strings here and
// become keywords in lib/transit (encodeGridCellsValue).
export function cellWire(cell: GridCell): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    id: cell.id,
    row: cell.row,
    "row-span": cell.rowSpan,
    column: cell.column,
    "column-span": cell.columnSpan,
    position: cell.position,
    "align-self": cell.alignSelf,
    "justify-self": cell.justifySelf,
    shapes: [...cell.shapes],
  };
  if (cell.areaName !== null) wire["area-name"] = cell.areaName;
  return wire;
}

// The layout-grid-cells value: a map of cell id -> cell.
export function cellsMap(cells: readonly GridCell[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const cell of cells) map[cell.id] = cellWire(cell);
  return map;
}

function overlaps(
  cell: GridCell,
  row: number,
  column: number,
  rowSpan: number,
  columnSpan: number,
): boolean {
  return (
    cell.row < row + rowSpan &&
    row < cell.row + cell.rowSpan &&
    cell.column < column + columnSpan &&
    column < cell.column + cell.columnSpan
  );
}

// One empty cell of the default shape (grid-cell-defaults).
function emptyCell(row: number, column: number, id: string): GridCell {
  return {
    id,
    row,
    rowSpan: 1,
    column,
    columnSpan: 1,
    position: "auto",
    alignSelf: "auto",
    justifySelf: "auto",
    areaName: null,
    shapes: [],
  };
}

// The partition invariant: drop the cells outside the track grid, clip the
// spans that run past it and create the cells the grid is missing. An empty
// grid has no cells.
export function normalizeCells(
  cells: readonly GridCell[],
  rows: number,
  columns: number,
  nextId: IdFactory = nextCellId,
): GridCell[] {
  const rowCount = Math.max(0, Math.trunc(rows));
  const columnCount = Math.max(0, Math.trunc(columns));
  if (rowCount === 0 || columnCount === 0) return [];

  const kept: GridCell[] = [];
  for (const cell of cells) {
    if (cell.row > rowCount || cell.column > columnCount) continue;
    const rowSpan = Math.min(cell.rowSpan, rowCount - cell.row + 1);
    const columnSpan = Math.min(cell.columnSpan, columnCount - cell.column + 1);
    kept.push(
      rowSpan === cell.rowSpan && columnSpan === cell.columnSpan
        ? cell
        : { ...cell, rowSpan, columnSpan },
    );
  }

  const covered = new Set<string>();
  for (const cell of kept) {
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      for (let column = cell.column; column < cell.column + cell.columnSpan; column += 1) {
        covered.add(`${row}:${column}`);
      }
    }
  }
  for (let row = 1; row <= rowCount; row += 1) {
    for (let column = 1; column <= columnCount; column += 1) {
      if (covered.has(`${row}:${column}`)) continue;
      kept.push(emptyCell(row, column, nextId()));
    }
  }
  return sortCells(kept, "row");
}

// The cell map after a track removal (index is 0-based): the cells of the
// removed line go away, the cells after it shift one line back and a cell
// spanning the line loses one unit of span.
export function removeTrackAt(
  cells: readonly GridCell[],
  axis: Axis,
  index: number,
): GridCell[] {
  const line = Math.trunc(index) + 1;
  const read = (cell: GridCell): [number, number] =>
    axis === "rows" ? [cell.row, cell.rowSpan] : [cell.column, cell.columnSpan];
  const write = (cell: GridCell, start: number, span: number): GridCell =>
    axis === "rows"
      ? { ...cell, row: start, rowSpan: span }
      : { ...cell, column: start, columnSpan: span };

  const out: GridCell[] = [];
  for (const cell of cells) {
    const [start, span] = read(cell);
    const end = start + span - 1;
    if (start > line) {
      out.push(write(cell, start - 1, span));
    } else if (line > end) {
      out.push(cell);
    } else if (span > 1) {
      // The line leaves the span; a cell that started on it now starts on
      // the track that takes its place, which keeps the same index.
      out.push(write(cell, start, span - 1));
    }
  }
  return out;
}

// The shape leaves every cell (free-cell-shapes); the cells stay.
function freeShape(cells: readonly GridCell[], shapeId: string): GridCell[] {
  return cells.map((cell) =>
    cell.shapes.includes(shapeId)
      ? { ...cell, shapes: cell.shapes.filter((id) => id !== shapeId) }
      : cell,
  );
}

// The manual placement (create-cells plus the target cell): the shape leaves
// its cells, every cell of the new area is dropped and the area becomes one
// manual cell that keeps the alignment of the cell it started on.
export function placeShape(
  cells: readonly GridCell[],
  shapeId: string,
  rect: { row: number; column: number; rowSpan: number; columnSpan: number },
  nextId: IdFactory = nextCellId,
): GridCell[] {
  const row = Math.max(1, Math.trunc(rect.row));
  const column = Math.max(1, Math.trunc(rect.column));
  const rowSpan = Math.max(1, Math.trunc(rect.rowSpan));
  const columnSpan = Math.max(1, Math.trunc(rect.columnSpan));

  const freed = freeShape(cells, shapeId);
  const previous = freed.find((cell) => cell.row === row && cell.column === column) ?? null;
  const kept = freed.filter((cell) => !overlaps(cell, row, column, rowSpan, columnSpan));

  const placed: GridCell = {
    id: previous === null ? nextId() : previous.id,
    row,
    rowSpan,
    column,
    columnSpan,
    position: "manual",
    alignSelf: previous === null ? "auto" : previous.alignSelf,
    justifySelf: previous === null ? "auto" : previous.justifySelf,
    areaName: null,
    shapes: [shapeId],
  };
  return sortCells([...kept, placed], "row");
}

// The automatic placement: the shape leaves its cell, that cell returns to
// the auto flow and any span it held is released (normalizeCells refills the
// intersections it had covered).
export function autoShape(
  cells: readonly GridCell[],
  shapeId: string,
  rows: number,
  columns: number,
  nextId: IdFactory = nextCellId,
): GridCell[] {
  const own = new Set(
    cells.filter((cell) => cell.shapes.includes(shapeId)).map((cell) => cell.id),
  );
  const freed = freeShape(cells, shapeId).map((cell) =>
    own.has(cell.id) && cell.shapes.length === 0
      ? { ...cell, position: "auto" as CellPosition, rowSpan: 1, columnSpan: 1 }
      : cell,
  );
  return normalizeCells(freed, rows, columns, nextId);
}

export interface GridAssignment {
  cells: GridCell[];
  rows: number;
  columns: number;
}

export interface AssignCellsInput {
  cells: readonly GridCell[];
  // Every child of the frame, in layer order.
  children: readonly string[];
  // The children the layout does not place (absolute, hidden).
  absolute?: ReadonlySet<string>;
  rows: number;
  columns: number;
  // layout-grid-dir: "row" fills the columns of a row first.
  direction: string;
  nextId?: IdFactory;
}

// The free cells a child can take, in reading order: auto, empty and 1x1.
function freeAutoCells(cells: readonly GridCell[], direction: string): GridCell[] {
  const free = cells.filter(
    (cell) =>
      cell.shapes.length === 0 &&
      cell.position === "auto" &&
      cell.rowSpan === 1 &&
      cell.columnSpan === 1,
  );
  return sortCells(free, direction);
}

// assign-cells: clean the cells whose shape left the layout, restore the
// partition, then place the orphans into the free auto cells of the reading
// order, adding a track when they do not fit.
export function assignCells(input: AssignCellsInput): GridAssignment {
  const nextId = input.nextId ?? nextCellId;
  const absolute = input.absolute ?? new Set<string>();
  const childSet = new Set(input.children);

  const assigned = new Set<string>();
  const cleaned: GridCell[] = [];
  for (const cell of input.cells) {
    const kept: string[] = [];
    for (const id of cell.shapes) {
      if (!childSet.has(id) || absolute.has(id) || assigned.has(id)) continue;
      assigned.add(id);
      kept.push(id);
    }
    cleaned.push(kept.length === cell.shapes.length ? cell : { ...cell, shapes: kept });
  }

  let rows = Math.max(0, Math.trunc(input.rows));
  let columns = Math.max(0, Math.trunc(input.columns));
  const pending = input.children.filter((id) => !assigned.has(id) && !absolute.has(id));
  // A grid without tracks cannot hold a cell; the first unplaced child
  // creates the 1x1 grid the CLJS assign-cells also starts from.
  if (pending.length > 0) {
    rows = Math.max(1, rows);
    columns = Math.max(1, columns);
  }

  const direction = input.direction === "column" ? "column" : "row";
  let cells = normalizeCells(cleaned, rows, columns, nextId);

  let pendingIndex = 0;
  while (pendingIndex < pending.length) {
    const free = freeAutoCells(cells, direction);
    if (free.length === 0) {
      // assign-cells adds a track along the grid direction; the new line
      // creates its cells and the loop keeps placing.
      if (direction === "row") columns += 1;
      else rows += 1;
      cells = normalizeCells(cells, rows, columns, nextId);
      continue;
    }
    const byId = new Map(cells.map((cell) => [cell.id, cell]));
    for (const cell of free) {
      if (pendingIndex >= pending.length) break;
      byId.set(cell.id, { ...cell, position: "auto", shapes: [pending[pendingIndex]] });
      pendingIndex += 1;
    }
    cells = sortCells([...byId.values()], direction);
  }

  return { cells, rows, columns };
}

// The children the grid places: the layer order minus the absolute and
// hidden ones, the same set check-deassigned-cells keeps.
export function flowChildIds(
  parent: WorkspaceShape,
  objects: WorkspaceObjects,
): string[] {
  const children = Array.isArray(parent.shapes) ? parent.shapes : [];
  return children.filter((id) => {
    const child = objects[id];
    return child !== undefined && child !== null && !isPositionAbsolute(child);
  });
}

function stateOf(parent: WorkspaceShape): GridState {
  const values = layoutValues(parent);
  return {
    rows: values.rows.map((track) => ({ ...track })),
    columns: values.columns.map((track) => ({ ...track })),
    cells: gridCellsOf(parent),
  };
}

// The default tracks the assignment had to append, so a caller that only
// sends the cells cannot leave them pointing at tracks the frame lacks.
function growTracks(tracks: readonly GridTrack[], count: number): GridTrack[] {
  const out = tracks.map((track) => ({ ...track }));
  while (out.length < count) out.push(defaultTrack());
  return out;
}

interface AssignmentContext {
  current: GridState;
  children: string[];
  absolute: Set<string>;
  direction: string;
}

function contextOf(parent: WorkspaceShape, objects: WorkspaceObjects): AssignmentContext {
  const current = stateOf(parent);
  const children = Array.isArray(parent.shapes) ? Array.from(parent.shapes) : [];
  const flow = new Set(flowChildIds(parent, objects));
  const absolute = new Set(children.filter((id) => !flow.has(id)));
  return { current, children, absolute, direction: layoutValues(parent).direction };
}

function assignWith(
  context: AssignmentContext,
  cells: readonly GridCell[],
  rows: readonly GridTrack[],
  columns: readonly GridTrack[],
  nextId: IdFactory,
): GridState {
  const assigned = assignCells({
    cells,
    children: context.children,
    absolute: context.absolute,
    rows: rows.length,
    columns: columns.length,
    direction: context.direction,
    nextId,
  });
  return {
    rows: growTracks(rows, assigned.rows),
    columns: growTracks(columns, assigned.columns),
    cells: assigned.cells,
  };
}

// The grid after a full assignment: used when a layout becomes a grid and by
// the self alignment edit, which needs the child to be in a cell first.
export function assignGrid(
  parent: WorkspaceShape,
  objects: WorkspaceObjects,
  nextId: IdFactory = nextCellId,
): GridState {
  const context = contextOf(parent, objects);
  return assignWith(
    context,
    context.current.cells,
    context.current.rows,
    context.current.columns,
    nextId,
  );
}

// The grid after a track edit of one axis (`tracks` is the new list) and,
// when `removed` is an index, after the cells of that line went away.
export function gridTrackEdit(
  parent: WorkspaceShape,
  objects: WorkspaceObjects,
  axis: Axis,
  tracks: readonly GridTrack[],
  removed: number | null,
  nextId: IdFactory = nextCellId,
): GridState {
  const context = contextOf(parent, objects);
  const rows = axis === "rows" ? tracks.map((track) => ({ ...track })) : context.current.rows;
  const columns =
    axis === "columns" ? tracks.map((track) => ({ ...track })) : context.current.columns;
  const cells = removed === null ? context.current.cells : removeTrackAt(context.current.cells, axis, removed);
  return assignWith(context, cells, rows, columns, nextId);
}

// The grid after placing one child: manual pins it to a rectangle (growing
// the tracks it needs), auto returns it to the flow.
export function gridPlacementEdit(
  parent: WorkspaceShape,
  objects: WorkspaceObjects,
  shapeId: string,
  placement: GridPlacement,
  nextId: IdFactory = nextCellId,
): GridState {
  const context = contextOf(parent, objects);
  const current = context.current;

  if (placement.mode === "auto") {
    const cells = autoShape(
      current.cells,
      shapeId,
      current.rows.length,
      current.columns.length,
      nextId,
    );
    return assignWith(context, cells, current.rows, current.columns, nextId);
  }

  const row = Math.max(1, Math.trunc(placement.row));
  const column = Math.max(1, Math.trunc(placement.column));
  const rowSpan = Math.max(1, Math.trunc(placement.rowSpan));
  const columnSpan = Math.max(1, Math.trunc(placement.columnSpan));
  const rows = growTracks(current.rows, Math.max(current.rows.length, row + rowSpan - 1));
  const columns = growTracks(
    current.columns,
    Math.max(current.columns.length, column + columnSpan - 1),
  );
  const normalized = normalizeCells(current.cells, rows.length, columns.length, nextId);
  const cells = placeShape(normalized, shapeId, { row, column, rowSpan, columnSpan }, nextId);
  return assignWith(context, cells, rows, columns, nextId);
}

// The grid after a self alignment edit of one child (the cell carries it).
export function gridSelfEdit(
  parent: WorkspaceShape,
  objects: WorkspaceObjects,
  shapeId: string,
  self: CellSelf,
  nextId: IdFactory = nextCellId,
): GridState {
  const context = contextOf(parent, objects);
  const assigned = assignGrid(parent, objects, nextId);
  const cells = assigned.cells.map((cell) => {
    if (!cell.shapes.includes(shapeId)) return cell;
    const next = { ...cell };
    if (self.alignSelf !== undefined) next.alignSelf = self.alignSelf ?? "auto";
    if (self.justifySelf !== undefined) next.justifySelf = self.justifySelf ?? "auto";
    return next;
  });
  return {
    rows: assigned.rows,
    columns: assigned.columns,
    cells: sortCells(cells, context.direction),
  };
}

// The wire patch of a grid state: the cells, plus the track lists when their
// length changed (a placement can grow them) or when the caller edited the
// tracks themselves.
export function gridStatePatch(
  state: GridState,
  parent: WorkspaceShape | null,
  sendTracks = false,
): Record<string, unknown> {
  const current = parent === null ? null : layoutValues(parent);
  const patch: Record<string, unknown> = { "layout-grid-cells": cellsMap(state.cells) };
  if (sendTracks || current === null || state.rows.length !== current.rows.length) {
    patch["layout-grid-rows"] = state.rows.map((track) => ({ ...track }));
  }
  if (sendTracks || current === null || state.columns.length !== current.columns.length) {
    patch["layout-grid-columns"] = state.columns.map((track) => ({ ...track }));
  }
  return patch;
}

// The values of the cell menu for one child.
export function gridCellValues(
  parent: WorkspaceShape | null,
  shapeId: string,
): GridCellValues {
  const cell = gridCellsOf(parent).find((entry) => entry.shapes.includes(shapeId)) ?? null;
  if (cell === null) {
    return {
      inCell: false,
      mode: "auto",
      row: 1,
      column: 1,
      rowSpan: 1,
      columnSpan: 1,
      alignSelf: "auto",
      justifySelf: "auto",
    };
  }
  const manual =
    cell.position === "manual" ||
    cell.position === "area" ||
    cell.rowSpan > 1 ||
    cell.columnSpan > 1;
  return {
    inCell: true,
    mode: manual ? "manual" : "auto",
    row: cell.row,
    column: cell.column,
    rowSpan: cell.rowSpan,
    columnSpan: cell.columnSpan,
    alignSelf: cell.alignSelf,
    justifySelf: cell.justifySelf,
  };
}
