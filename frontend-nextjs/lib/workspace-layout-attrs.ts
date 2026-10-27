// Layout and constraint attribute model of the workspace shell (F9.9).
//
// Ported from:
// - common/src/app/common/types/shape/layout.cljc: the layout-attrs and
//   layout-child-attrs schemas, their enum sets and default-track-value;
// - frontend/src/app/main/data/workspace/shape_layout.cljs:
//   initial-flex-layout, initial-grid-layout and the create path that drops
//   the children constraints;
// - common/src/app/common/geom/shapes/constraints.cljc:
//   default-constraints-h / default-constraints-v;
// - frontend/src/app/main/ui/workspace/sidebar/options/menus/measures.cljs:
//   the disabled rules of the position and size fields.
//
// Kept free of JSX and of the CLJS runtime so vitest exercises every branch.
// The panel owns the drafts and the canvas owns the RPC; this module only
// reads the stored values and builds the attribute patches the panel sends.
//
// Deviations from the CLJS original, documented:
// - The wire `set` replaces the whole value while the CLJS update-layout
//   deep-merges with d/patch-object, so every map here is sent complete:
//   the padding quad always carries p1..p4 and the gap map always carries
//   both gaps. A partial map would fail the schema required keys.
// - remove-layout clears the grid keys too. The CLJS layout-keys list only
//   names the flex keys (an upstream omission), which leaves the grid keys
//   behind on a removed grid layout.
// - The layout reflow is not ported: render-wasm only reflows inside the
//   modifier pipeline, so a layout attribute change is stored and uploaded
//   but the children move on the next modifier of the parent, not at once.
//   Grid cells (layout-grid-cells) are not edited by the panel.
// - The constraints are stored here and applied by the transform commits:
//   lib/workspace-constraints.ts ports the axis map of
//   geom/shapes/constraints.cljc and spreads it over the children of a
//   resized container (F9.10).
//
// The labels of the enum controls are hardcoded English, like the
// layout_container.cljs titles the CLJS panel renders (it uses icon titles
// for most of them); the shared po files carry no keys for these enums.

import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceShape } from "@/lib/workspace";
import { isFlexLayout } from "@/lib/workspace-layout";

export type LayoutKind = "flex" | "grid";
export type GridTrackType = "percent" | "flex" | "auto" | "fixed";

// layout.cljc: the enum sets of schema:layout-attrs and
// schema:layout-child-attrs.
export const FLEX_DIRECTIONS = ["row", "row-reverse", "column", "column-reverse"] as const;
export const GRID_DIRECTIONS = ["row", "column"] as const;
export const WRAP_TYPES = ["wrap", "nowrap"] as const;
export const ALIGN_ITEMS = ["start", "end", "center", "stretch"] as const;
export const ALIGN_CONTENT = [
  "start",
  "end",
  "center",
  "space-between",
  "space-around",
  "space-evenly",
  "stretch",
] as const;
export const JUSTIFY_CONTENT = ALIGN_CONTENT;
export const JUSTIFY_ITEMS = ALIGN_ITEMS;
export const GAP_TYPES = ["simple", "multiple"] as const;
export const PADDING_TYPES = ["simple", "multiple"] as const;
export const TRACK_TYPES = ["percent", "flex", "auto", "fixed"] as const;
export const SIZING = ["fix", "auto", "fill"] as const;
export const ALIGN_SELF = ["start", "end", "center", "stretch"] as const;
export const CONSTRAINT_H = ["left", "right", "leftright", "center", "scale"] as const;
export const CONSTRAINT_V = ["top", "bottom", "topbottom", "center", "scale"] as const;

// Every container attribute a layout owns, the grid ones included.
export const LAYOUT_ATTRS = [
  "layout",
  "layout-flex-dir",
  "layout-gap-type",
  "layout-gap",
  "layout-align-items",
  "layout-justify-content",
  "layout-align-content",
  "layout-wrap-type",
  "layout-padding-type",
  "layout-padding",
  "layout-justify-items",
  "layout-grid-dir",
  "layout-grid-rows",
  "layout-grid-columns",
  "layout-grid-cells",
] as const;

// Every attribute of a shape that sits inside a layout.
export const LAYOUT_ITEM_ATTRS = [
  "layout-item-margin",
  "layout-item-margin-type",
  "layout-item-max-h",
  "layout-item-max-w",
  "layout-item-min-h",
  "layout-item-min-w",
  "layout-item-h-sizing",
  "layout-item-v-sizing",
  "layout-item-align-self",
  "layout-item-absolute",
  "layout-item-z-index",
] as const;

// The three attributes the constraints menu edits.
export const CONSTRAINT_ATTRS = ["constraints-h", "constraints-v", "fixed-scroll"] as const;

// A padding or margin map: the four sides in CLJS p1..p4 / m1..m4 order.
export interface Quad {
  p1: number;
  p2: number;
  p3: number;
  p4: number;
}

export interface GridTrack {
  type: GridTrackType;
  value?: number;
}

export interface LayoutValues {
  kind: LayoutKind | null;
  direction: string;
  wrap: string;
  gapType: string;
  rowGap: number;
  columnGap: number;
  alignItems: string;
  alignContent: string;
  justifyContent: string;
  justifyItems: string;
  paddingType: string;
  padding: [number, number, number, number];
  rows: GridTrack[];
  columns: GridTrack[];
}

export interface LayoutItemValues {
  hSizing: string;
  vSizing: string;
  alignSelf: string;
  absolute: boolean;
  zIndex: number;
  minW: number | null;
  minH: number | null;
  maxW: number | null;
  maxH: number | null;
  marginType: string;
  margin: [number, number, number, number];
}

export interface ConstraintValues {
  h: string;
  v: string;
  fixedScroll: boolean;
}

export interface MeasureLocks {
  position: boolean;
  width: boolean;
  height: boolean;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringOf(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function numberOf(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalNumberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// One side map ({p1..p4} or {m1..m4}) as a tuple; a missing map reads zero.
function quadOf(value: unknown): [number, number, number, number] {
  const record = recordOf(value);
  if (record === null) return [0, 0, 0, 0];
  return [
    numberOf(record["p1"] ?? record["m1"], 0),
    numberOf(record["p2"] ?? record["m2"], 0),
    numberOf(record["p3"] ?? record["m3"], 0),
    numberOf(record["p4"] ?? record["m4"], 0),
  ];
}

// The two-value form of a simple padding/margin: vertical first, horizontal
// second, mirroring the CLJS simple mode (p1/p3 share, p2/p4 share).
export function simpleQuad(
  vertical: number,
  horizontal: number,
): [number, number, number, number] {
  return [vertical, horizontal, vertical, horizontal];
}

// layout.cljc layout?: the kind of layout a frame carries, null otherwise.
export function layoutKindOf(shape: WorkspaceShape): LayoutKind | null {
  if (shape.type !== "frame") return null;
  if (shape["layout"] === "flex") return "flex";
  if (shape["layout"] === "grid") return "grid";
  return null;
}

// default-track-value of layout.cljc.
export function defaultTrack(): GridTrack {
  return { type: "flex", value: 1 };
}

// One stored track; an unknown type falls back to the flex default.
export function trackOf(value: unknown): GridTrack {
  const record = recordOf(value);
  if (record === null) return defaultTrack();
  const type = stringOf(record["type"], "flex");
  if (!(TRACK_TYPES as readonly string[]).includes(type)) return defaultTrack();
  const track: GridTrack = { type: type as GridTrackType };
  if (type !== "auto") track.value = numberOf(record["value"], 1);
  return track;
}

function tracksOf(value: unknown): GridTrack[] {
  return Array.isArray(value) ? value.map(trackOf) : [];
}

// The values the panel shows for a layout container. The defaults follow
// initial-flex-layout / initial-grid-layout of shape_layout.cljs, so a frame
// mid-migration or a record with a missing key still renders the value the
// editor would create.
export function layoutValues(shape: WorkspaceShape): LayoutValues {
  const kind = layoutKindOf(shape);
  const grid = kind === "grid";
  const gap = recordOf(shape["layout-gap"]);
  return {
    kind,
    direction: stringOf(shape[grid ? "layout-grid-dir" : "layout-flex-dir"], "row"),
    wrap: stringOf(shape["layout-wrap-type"], "nowrap"),
    gapType: stringOf(shape["layout-gap-type"], "multiple"),
    rowGap: numberOf(gap?.["row-gap"], 0),
    columnGap: numberOf(gap?.["column-gap"], 0),
    alignItems: stringOf(shape["layout-align-items"], "start"),
    alignContent: stringOf(shape["layout-align-content"], "stretch"),
    justifyContent: stringOf(shape["layout-justify-content"], grid ? "stretch" : "start"),
    justifyItems: stringOf(shape["layout-justify-items"], "start"),
    paddingType: stringOf(shape["layout-padding-type"], "simple"),
    padding: quadOf(shape["layout-padding"]),
    rows: tracksOf(shape["layout-grid-rows"]),
    columns: tracksOf(shape["layout-grid-columns"]),
  };
}

// initial-flex-layout of shape_layout.cljs. The panel only turns frames into
// layouts, so the non-frame branch of get-layout-initializer (show-content on,
// hide-in-viewer on) never runs here and is not ported.
export function layoutPatch(kind: LayoutKind): Record<string, unknown> {
  const gap = { "row-gap": 0, "column-gap": 0 };
  const padding = { p1: 0, p2: 0, p3: 0, p4: 0 };
  if (kind === "grid") {
    return {
      layout: "grid",
      "layout-grid-dir": "row",
      "layout-gap-type": "multiple",
      "layout-gap": gap,
      "layout-align-items": "start",
      "layout-justify-items": "start",
      "layout-align-content": "stretch",
      "layout-justify-content": "stretch",
      "layout-padding-type": "simple",
      "layout-padding": padding,
      "layout-grid-cells": {},
      "layout-grid-rows": [],
      "layout-grid-columns": [],
    };
  }
  return {
    layout: "flex",
    "layout-flex-dir": "row",
    "layout-gap-type": "multiple",
    "layout-gap": gap,
    "layout-align-items": "start",
    "layout-justify-content": "start",
    "layout-align-content": "stretch",
    "layout-wrap-type": "nowrap",
    "layout-padding-type": "simple",
    "layout-padding": padding,
  };
}

// remove-layout: a nil val deletes the attribute on both the backend and the
// local model (workspace-undo's applyUpdateChanges). Every layout attribute
// is cleared, the grid ones included (see the header note).
export function removeLayoutPatch(): Record<string, null> {
  const patch: Record<string, null> = {};
  for (const attr of LAYOUT_ATTRS) patch[attr] = null;
  return patch;
}

// The gap edit: simple keeps both gaps equal, multiple edits them apart. The
// map is always complete because the wire replaces the value.
export function gapPatch(
  gapType: string,
  rowGap: number,
  columnGap: number,
): Record<string, unknown> {
  const simple = gapType !== "multiple";
  return {
    "layout-gap-type": simple ? "simple" : "multiple",
    "layout-gap": {
      "row-gap": Math.max(0, rowGap),
      "column-gap": Math.max(0, simple ? rowGap : columnGap),
    },
  };
}

// The padding edit; the quad carries all four sides (see simpleQuad).
export function paddingPatch(
  paddingType: string,
  quad: readonly [number, number, number, number],
): Record<string, unknown> {
  return {
    "layout-padding-type": paddingType === "multiple" ? "multiple" : "simple",
    "layout-padding": {
      p1: Math.max(0, quad[0]),
      p2: Math.max(0, quad[1]),
      p3: Math.max(0, quad[2]),
      p4: Math.max(0, quad[3]),
    },
  };
}

// The layout-item margin edit; the quad carries all four sides.
export function marginPatch(
  marginType: string,
  quad: readonly [number, number, number, number],
): Record<string, unknown> {
  return {
    "layout-item-margin-type": marginType === "multiple" ? "multiple" : "simple",
    "layout-item-margin": {
      m1: quad[0],
      m2: quad[1],
      m3: quad[2],
      m4: quad[3],
    },
  };
}

// One grid track from the type select and the value input. The auto type has
// no value (schema:layout-track leaves it optional).
export function trackPatch(type: string, value: number | null): GridTrack {
  if (type === "auto") return { type: "auto" };
  const valid = (TRACK_TYPES as readonly string[]).includes(type)
    ? (type as GridTrackType)
    : "flex";
  return { type: valid, value: Math.max(0, value ?? 1) };
}

// The track list of one axis, ready for the wire. The values are plain
// maps; the schema validates each one.
export function tracksPatch(
  axis: "rows" | "columns",
  tracks: readonly GridTrack[],
): Record<string, unknown> {
  const attr = axis === "rows" ? "layout-grid-rows" : "layout-grid-columns";
  return { [attr]: tracks.map((track) => ({ ...track })) };
}

// The layout-item values of a shape; a missing key reads the one the CLJS
// editor shows (fix sizing, stretch align-self, simple margin, zero z).
export function layoutItemValues(shape: WorkspaceShape): LayoutItemValues {
  return {
    hSizing: stringOf(shape["layout-item-h-sizing"], "fix"),
    vSizing: stringOf(shape["layout-item-v-sizing"], "fix"),
    alignSelf: stringOf(shape["layout-item-align-self"], "stretch"),
    absolute: shape["layout-item-absolute"] === true,
    zIndex: numberOf(shape["layout-item-z-index"], 0),
    minW: optionalNumberOf(shape["layout-item-min-w"]),
    minH: optionalNumberOf(shape["layout-item-min-h"]),
    maxW: optionalNumberOf(shape["layout-item-max-w"]),
    maxH: optionalNumberOf(shape["layout-item-max-h"]),
    marginType: stringOf(shape["layout-item-margin-type"], "simple"),
    margin: quadOf(shape["layout-item-margin"]),
  };
}

// constraints.cljc in-frame?: a shape whose parent is not the root board.
// The root itself has no constraints menu.
export function inFrameForConstraints(shape: WorkspaceShape): boolean {
  const parentId = shape["parent-id"];
  return typeof parentId === "string" && parentId !== ZERO_UUID;
}

// constraints.cljs: the fixed-scroll toggle only shows for a first-level
// child, the shape whose parent is the frame it belongs to.
export function fixedScrollVisible(shape: WorkspaceShape): boolean {
  const parentId = shape["parent-id"];
  return typeof parentId === "string" && parentId === shape["frame-id"];
}

// default-constraints-h / -v: a child of a frame pins to the start edge, any
// other child scales with its parent.
function defaultConstraintH(parent: WorkspaceShape | null): string {
  return parent !== null && parent.type === "frame" ? "left" : "scale";
}

function defaultConstraintV(parent: WorkspaceShape | null): string {
  return parent !== null && parent.type === "frame" ? "top" : "scale";
}

export function constraintsOf(
  shape: WorkspaceShape,
  parent: WorkspaceShape | null,
): ConstraintValues {
  return {
    h: stringOf(shape["constraints-h"], defaultConstraintH(parent)),
    v: stringOf(shape["constraints-v"], defaultConstraintV(parent)),
    fixedScroll: shape["fixed-scroll"] === true,
  };
}

// The constraint edit; a value outside the enum keeps the stored attribute.
export function constraintPatch(
  h: string | null,
  v: string | null,
): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (h !== null && (CONSTRAINT_H as readonly string[]).includes(h)) {
    patch["constraints-h"] = h;
  }
  if (v !== null && (CONSTRAINT_V as readonly string[]).includes(v)) {
    patch["constraints-v"] = v;
  }
  return patch;
}

// The disabled rules of menus/measures.cljs. Only the explicit
// layout-item-absolute flag counts here: the layout predicate also folds in
// hidden shapes, which the measures menu does not.
export function measureLocks(
  shape: WorkspaceShape,
  parent: WorkspaceShape | null,
): MeasureLocks {
  const absolute = shape["layout-item-absolute"] === true;
  const flexChild = isFlexLayout(parent);
  const flexContainer = isFlexLayout(shape);
  const autoOrFillW =
    shape["layout-item-h-sizing"] === "auto" || shape["layout-item-h-sizing"] === "fill";
  const autoOrFillH =
    shape["layout-item-v-sizing"] === "auto" || shape["layout-item-v-sizing"] === "fill";
  return {
    position: flexChild && !absolute,
    width: (flexChild || flexContainer) && autoOrFillW && !absolute,
    height: (flexChild || flexContainer) && autoOrFillH && !absolute,
  };
}
