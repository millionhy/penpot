// The guides menu of the workspace style panel (F9.14): the layout grids of
// a frame (its :grids vector) and the pure surgery behind the rows.
//
// Ported from:
// - common/src/app/common/types/grid.cljc (schema:grid and the
//   default-square-params / default-layout-params of a new grid);
// - common/src/app/common/geom/grid.cljc (calculate-default-item-length);
// - frontend/src/app/main/data/workspace/grid.cljs (add-frame-grid,
//   remove-frame-grid, set-frame-grid: the grid the add button appends is a
//   square grid with display true);
// - frontend/src/app/main/ui/workspace/sidebar/options/menus/frame_grid.cljs
//   (the type / size / gutter / margin / item-length / color rows).
//
// A grid is a plain map: {:type :square/:column/:row, :display bool,
// :params {...}}. The backend validates the whole shape after a mod-obj, so
// every helper keeps the params inside schema:square-params /
// schema:column-params: a square grid carries only size and color, a column
// or row grid adds the orientation type, the item length, the gutter and the
// margin.
//
// Deviations from the CLJS original, documented (AD12):
// - The page-level default grids (reset to default / save as default) are
//   not stored here: a new grid always starts from the catalog defaults.
// - The renderer does not draw the grids yet (the wasm bridge has no grid
//   pass); the rows still persist the attribute.

import type { WorkspaceShape } from "@/lib/workspace";

export type GuideType = "square" | "column" | "row";

export interface GuideColor {
  color: string;
  opacity: number;
}

export interface GuideGrid {
  type: GuideType;
  display: boolean;
  params: Record<string, unknown>;
}

// cts/grid: the information color of a square grid and the layout color of a
// column or row grid, with their default opacities.
export const DEFAULT_SQUARE_COLOR: GuideColor = { color: "#59B9E2", opacity: 0.4 };
export const DEFAULT_LAYOUT_COLOR: GuideColor = { color: "#DE4762", opacity: 0.1 };

// grid.cljc default-items: the item count a computed item length assumes.
const DEFAULT_ITEMS = 12;

const TYPES = new Set<string>(["square", "column", "row"]);

// ctg/default-grid-params, as a fresh object per call so a row edit cannot
// mutate the catalog.
export function defaultGridParams(type: GuideType): Record<string, unknown> {
  if (type === "square") {
    return { size: 16, color: { ...DEFAULT_SQUARE_COLOR } };
  }
  return {
    size: 12,
    type: "stretch",
    "item-length": null,
    gutter: 8,
    margin: 0,
    color: { ...DEFAULT_LAYOUT_COLOR },
  };
}

// The grid of dw/add-frame-grid: a square grid with display true.
export function newGuide(type: GuideType = "square"): GuideGrid {
  return { type, display: true, params: defaultGridParams(type) };
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function cloneParams(params: Record<string, unknown>): Record<string, unknown> {
  const color = recordOf(params.color);
  if (color === null) return { ...params };
  return { ...params, color: { ...color } };
}

function cloneGrid(grid: GuideGrid): GuideGrid {
  return { ...grid, params: cloneParams(grid.params) };
}

// The :grids of a shape, sanitized: an unknown type or a malformed params
// map drops the row instead of breaking the panel.
export function guidesOf(shape: WorkspaceShape): GuideGrid[] {
  const grids = shape["grids"];
  if (!Array.isArray(grids)) return [];
  const out: GuideGrid[] = [];
  for (const item of grids) {
    const record = recordOf(item);
    if (record === null) continue;
    const type = record.type;
    if (typeof type !== "string" || !TYPES.has(type)) continue;
    const params = recordOf(record.params);
    out.push({
      type: type as GuideType,
      display: record.display !== false,
      params: params === null ? {} : { ...params },
    });
  }
  return out;
}

// dw/add-frame-grid: append the new grid after the stored ones.
export function addGuide(guides: readonly GuideGrid[], type: GuideType = "square"): GuideGrid[] {
  return [...guides.map(cloneGrid), newGuide(type)];
}

// d/remove-at-index: an out-of-range index changes nothing.
export function removeGuide(guides: readonly GuideGrid[], index: number): GuideGrid[] {
  return guides.filter((_, position) => position !== index).map(cloneGrid);
}

// One grid replaced by the caller's copy; the other rows stay shared.
function replaceGuide(
  guides: readonly GuideGrid[],
  index: number,
  next: GuideGrid,
): GuideGrid[] {
  const copy = { ...next, params: cloneParams(next.params) };
  return guides.map((grid, position) => (position === index ? copy : grid));
}

// The type select: a new type starts from its own defaults, like
// handle-change-type (the params of the previous type never carry over).
export function withGuideType(
  guides: readonly GuideGrid[],
  index: number,
  type: GuideType,
): GuideGrid[] {
  if (!TYPES.has(type)) return guides.map(cloneGrid);
  return replaceGuide(guides, index, newGuide(type));
}

// The eye button: a missing display reads as shown, the toggle writes the
// explicit boolean.
export function withGuideDisplay(
  guides: readonly GuideGrid[],
  index: number,
  display: boolean,
): GuideGrid[] {
  const grid = guides[index];
  if (grid === undefined) return guides.map(cloneGrid);
  return replaceGuide(guides, index, { ...grid, display });
}

// A params field written in place (the orientation type, the gutter, the
// margin, the size).
export function withGuideParams(
  guides: readonly GuideGrid[],
  index: number,
  patch: Record<string, unknown>,
): GuideGrid[] {
  const grid = guides[index];
  if (grid === undefined) return guides.map(cloneGrid);
  return replaceGuide(guides, index, {
    ...grid,
    params: { ...grid.params, ...patch },
  });
}

// The color row: the stored color map keeps only the hex and the opacity
// (schema:grid-color reads nothing else).
export function withGuideColor(
  guides: readonly GuideGrid[],
  index: number,
  color: string,
  opacity?: number,
): GuideGrid[] {
  const grid = guides[index];
  if (grid === undefined) return guides.map(cloneGrid);
  const current = guideColorOf(grid);
  const next: GuideColor = {
    color,
    opacity: opacity === undefined ? current.opacity : clampOpacity(opacity),
  };
  return replaceGuide(guides, index, {
    ...grid,
    params: { ...grid.params, color: next },
  });
}

export function guideColorOf(grid: GuideGrid): GuideColor {
  const color = recordOf(grid.params.color);
  const fallback = grid.type === "square" ? DEFAULT_SQUARE_COLOR : DEFAULT_LAYOUT_COLOR;
  if (color === null) return { ...fallback };
  const value = color.color;
  const opacity = color.opacity;
  return {
    color: typeof value === "string" ? value : fallback.color,
    opacity: typeof opacity === "number" && Number.isFinite(opacity)
      ? clampOpacity(opacity)
      : fallback.opacity,
  };
}

function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// gg/calculate-default-item-length, with the Clojure expression verbatim:
// the space it spreads is (- frame-length (+ margin (- margin gutter))
// (* gutter 12)), so the two margins cancel out and the gutter is removed
// eleven times. Quirky, but the reference panel shows these numbers.
export function calculateDefaultItemLength(
  frameLength: number,
  margin: number,
  gutter: number,
): number {
  if (!Number.isFinite(frameLength) || frameLength <= 0) return 0;
  const usable = frameLength - (margin + (margin - gutter)) - gutter * DEFAULT_ITEMS;
  return usable / DEFAULT_ITEMS;
}

// handle-change-size: a typed size wins; the auto option (null) recomputes
// the item length from the frame side.
export function withGuideSize(
  guides: readonly GuideGrid[],
  index: number,
  size: number | null,
  frameLength: number,
): GuideGrid[] {
  const grid = guides[index];
  if (grid === undefined) return guides.map(cloneGrid);
  const margin = positive(grid.params.margin) ?? 0;
  const gutter = positive(grid.params.gutter) ?? 0;
  const itemLength =
    size === null
      ? calculateDefaultItemLength(frameLength, margin, gutter)
      : (positive(grid.params["item-length"]) ?? null);
  return withGuideParams(guides, index, { size, "item-length": itemLength });
}

// handle-change-item-length: a zero clears the item length, and an empty
// value with an empty size falls back to the 12 column default.
export function withGuideItemLength(
  guides: readonly GuideGrid[],
  index: number,
  itemLength: number | null,
): GuideGrid[] {
  const grid = guides[index];
  if (grid === undefined) return guides.map(cloneGrid);
  const value = itemLength === null || itemLength === 0 ? null : itemLength;
  const size = positive(grid.params.size);
  return withGuideParams(guides, index, {
    size: value === null && size === null ? 12 : size,
    "item-length": value,
  });
}

// The :grids attribute a commit sends; a frame without grids sends the empty
// vector the schema accepts (the CLJS remove-all does the same).
export function guidePatch(guides: readonly GuideGrid[]): GuideGrid[] {
  return guides.map(cloneGrid);
}
