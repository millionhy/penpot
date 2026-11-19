// The layout setters of app.render-wasm.api: flex/grid containers and the
// layout-item data of a child.
//
// The cold-load batch carries flex and layout-item inside each shape record
// (`includeLayout`), so the host only runs the grid half there. The
// incremental path uploads the record without layout, so it replays the whole
// sequence: clear, flex, grid, and the layout-item data.
//
// Grid tracks and cells travel through the single alloc buffer:
//   track  8 bytes  u8 type, 3 pad, f32 value
//   cell  40 bytes  4 x i32, u8 align-self, u8 justify-self, 2 pad, uuid
// The empty lists still call their setter; the Rust side reads a missing
// buffer as zero entries (`mem::bytes_or_empty`), which is why no zero-size
// allocation runs.

import { call } from "./call";
import { alloc, dataView, heapU8 } from "./memory";
import { live, type RenderWasmModule } from "./module";
import {
  translateAlignSelf,
  translateGridTrackType,
  translateJustifySelf,
  translateLayoutAlignContent,
  translateLayoutAlignItems,
  translateLayoutFlexDir,
  translateLayoutGridDir,
  translateLayoutJustifyContent,
  translateLayoutJustifyItems,
  translateLayoutSizing,
  translateLayoutWrapType,
} from "./serializers";
import type { GridCell, GridTrack, Shape } from "./upload";
import { ZERO_UUID, isUuid, uuidToU32 } from "./uuid";

export const GRID_TRACK_U8_SIZE = 8;
export const GRID_CELL_U8_SIZE = 40;

export type { GridCell, GridTrack };

// a-frame-with-layout?: the two container kinds only exist on frames.
export function isFlexLayout(shape: Shape): boolean {
  return shape.type === "frame" && shape.layout === "flex";
}

export function isGridLayout(shape: Shape): boolean {
  return shape.type === "frame" && shape.layout === "grid";
}

function gapOf(shape: Shape): { rowGap: number; columnGap: number } {
  const gap = shape["layout-gap"];
  return {
    rowGap: gap?.["row-gap"] ?? 0,
    columnGap: gap?.["column-gap"] ?? 0,
  };
}

function paddingOf(shape: Shape): [number, number, number, number] {
  const padding = shape["layout-padding"];
  return [padding?.p1 ?? 0, padding?.p2 ?? 0, padding?.p3 ?? 0, padding?.p4 ?? 0];
}

// set-flex-layout: the container data; the children carry their own
// layout-item data.
export function setFlexLayoutData(module: RenderWasmModule, shape: Shape): void {
  if (!live()) return;
  const { rowGap, columnGap } = gapOf(shape);
  const [top, right, bottom, left] = paddingOf(shape);

  call(
    module,
    "_set_flex_layout_data",
    translateLayoutFlexDir(shape["layout-flex-dir"] ?? "row") ?? 0,
    rowGap,
    columnGap,
    translateLayoutAlignItems(shape["layout-align-items"]) ?? 0,
    translateLayoutAlignContent(shape["layout-align-content"]) ?? 0,
    translateLayoutJustifyItems(shape["layout-justify-items"]) ?? 0,
    translateLayoutJustifyContent(shape["layout-justify-content"]) ?? 0,
    translateLayoutWrapType(shape["layout-wrap-type"]) ?? 0,
    top,
    right,
    bottom,
    left,
  );
}

// set-grid-layout-data: same gaps, padding and alignment table, one byte for
// the direction instead of the eight flex values.
export function setGridLayoutData(module: RenderWasmModule, shape: Shape): void {
  if (!live()) return;
  const { rowGap, columnGap } = gapOf(shape);
  const [top, right, bottom, left] = paddingOf(shape);

  call(
    module,
    "_set_grid_layout_data",
    translateLayoutGridDir(shape["layout-grid-dir"] ?? "row") ?? 0,
    rowGap,
    columnGap,
    translateLayoutAlignItems(shape["layout-align-items"]) ?? 0,
    translateLayoutAlignContent(shape["layout-align-content"]) ?? 0,
    translateLayoutJustifyItems(shape["layout-justify-items"]) ?? 0,
    translateLayoutJustifyContent(shape["layout-justify-content"]) ?? 0,
    top,
    right,
    bottom,
    left,
  );
}

function writeTracks(
  module: RenderWasmModule,
  tracks: readonly GridTrack[],
  setter: string,
): void {
  if (tracks.length > 0) {
    const offset = alloc(module, tracks.length * GRID_TRACK_U8_SIZE);
    const view = dataView(heapU8(module));
    let at = offset;
    for (const track of tracks) {
      view.setUint8(at, translateGridTrackType(track.type) ?? 0);
      // Three pad bytes stay as the allocation left them.
      view.setFloat32(at + 4, track.value ?? 0, true);
      at += GRID_TRACK_U8_SIZE;
    }
  }
  call(module, setter);
}

export function setGridRows(module: RenderWasmModule, tracks: readonly GridTrack[]): void {
  if (!live()) return;
  writeTracks(module, tracks, "_set_grid_rows");
}

export function setGridColumns(
  module: RenderWasmModule,
  tracks: readonly GridTrack[],
): void {
  if (!live()) return;
  writeTracks(module, tracks, "_set_grid_columns");
}

// set-grid-layout-cells: one record per cell. The model keys the map by cell
// id; the renderer reads the values in insertion order and ignores the key.
// A cell without a shape answers the zero uuid, which the Rust side turns
// into `None`.
export function setGridCells(
  module: RenderWasmModule,
  cells: Readonly<Record<string, GridCell>>,
): void {
  if (!live()) return;
  const entries = Object.values(cells);

  if (entries.length > 0) {
    const offset = alloc(module, entries.length * GRID_CELL_U8_SIZE);
    const view = dataView(heapU8(module));
    let at = offset;
    for (const cell of entries) {
      const shapeId = cell.shapes?.[0];
      view.setInt32(at, cell.row ?? 0, true);
      view.setInt32(at + 4, cell["row-span"] ?? 0, true);
      view.setInt32(at + 8, cell.column ?? 0, true);
      view.setInt32(at + 12, cell["column-span"] ?? 0, true);
      view.setUint8(at + 16, translateAlignSelf(cell["align-self"]) ?? 0);
      view.setUint8(at + 17, translateJustifySelf(cell["justify-self"]) ?? 0);
      // Two pad bytes, then the shape uuid.
      const words = uuidToU32(isUuid(shapeId) ? shapeId : ZERO_UUID);
      for (let index = 0; index < 4; index += 1) {
        view.setUint32(at + 20 + index * 4, words[index], true);
      }
      at += GRID_CELL_U8_SIZE;
    }
  }
  call(module, "_set_grid_cells");
}

// set-grid-layout: the container data plus its three track lists.
export function setGridLayout(module: RenderWasmModule, shape: Shape): void {
  setGridLayoutData(module, shape);
  setGridRows(module, shape["layout-grid-rows"] ?? []);
  setGridColumns(module, shape["layout-grid-columns"] ?? []);
  setGridCells(module, shape["layout-grid-cells"] ?? {});
}

// set-layout-data: the layout-item half of a child.
export function setLayoutData(module: RenderWasmModule, shape: Shape): void {
  if (!live()) return;
  const margins = shape["layout-item-margin"];
  const maxH = shape["layout-item-max-h"];
  const minH = shape["layout-item-min-h"];
  const maxW = shape["layout-item-max-w"];
  const minW = shape["layout-item-min-w"];

  call(
    module,
    "_set_layout_data",
    margins?.m1 ?? 0,
    margins?.m2 ?? 0,
    margins?.m3 ?? 0,
    margins?.m4 ?? 0,
    translateLayoutSizing(shape["layout-item-h-sizing"]) ?? 0,
    translateLayoutSizing(shape["layout-item-v-sizing"]) ?? 0,
    maxH !== null && maxH !== undefined,
    maxH ?? 0,
    minH !== null && minH !== undefined,
    minH ?? 0,
    maxW !== null && maxW !== undefined,
    maxW ?? 0,
    minW !== null && minW !== undefined,
    minW ?? 0,
    translateAlignSelf(shape["layout-item-align-self"]) ?? 0,
    shape["layout-item-absolute"] === true,
    shape["layout-item-z-index"] ?? 0,
  );
}

export function clearLayout(module: RenderWasmModule): void {
  if (!live()) return;
  call(module, "_clear_shape_layout");
}

// set-shape-layout: clear first, then the container data that applies. The
// compiled original clears every shape, layout or not, so a shape that lost
// its layout stops answering the old one.
export function setShapeLayout(module: RenderWasmModule, shape: Shape): void {
  clearLayout(module);
  if (isFlexLayout(shape)) setFlexLayoutData(module, shape);
  if (isGridLayout(shape)) setGridLayout(module, shape);
}