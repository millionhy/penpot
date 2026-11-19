// The modifier protocol of app.render-wasm.api: the per-gesture transform
// overrides, the structural edits a layout reflow sends, and the geometry
// the renderer answers after propagating a transform through the tree.
//
// Ported from the CLJS namespace plus the $APP wrapper under
// lib/render-wasm (modifiers.ts / propagate.ts); the layouts are verified
// against render-wasm/src (wasm/transforms.rs, main.rs) because the CLJS
// caller is the only other place that reads them.
//
// Buffer discipline (render-wasm/src/mem.rs): the artifact keeps ONE pending
// allocation. `_set_modifiers` and `_propagate_modifiers` consume the input
// through `mem::bytes()`; `_set_structure_modifiers` also frees its own
// buffer. The only place that needs `_free_bytes` is the result buffer the
// renderer writes back from `_propagate_modifiers`, and the heap views must
// be re-read after every allocation.

import { call } from "./call";
import { EngineError } from "./errors";
import { alloc, dataView, free, heapF32, heapU32, heapU8, offset32 } from "./memory";
import { ready, type RenderWasmModule } from "./module";
import {
  nameOf,
  translateStructureModifierType,
  translateTransformEntryKind,
  type EnumValue,
} from "./serializers";
import { u32ToUuid, uuidToU32 } from "./uuid";

// MODIFIER-U8-SIZE (app.render-wasm.api): one uuid as 4 x u32 (16 bytes)
// followed by one matrix as 6 x f32 (24 bytes), a..f in that slot order.
export const MODIFIER_U8_SIZE = 40;

// INPUT-MODIFIER-U8-SIZE: the same matrix entry plus a trailing u32 kind
// (RawTransformEntry is 44 bytes once aligned).
export const INPUT_MODIFIER_U8_SIZE = 44;

// StructureEntry (render-wasm/src/shapes/transform.rs): type, index, parent
// uuid, id uuid, value.
export const STRUCTURE_MODIFIER_U8_SIZE = 44;

// One propagated result: uuid as 4 x u32 plus the matrix as 6 x f32.
export const OUTPUT_MODIFIER_U32_SIZE = 10;

// The (a, b, c, d, e, f) tuple of a penpot matrix; a translation uses
// (1, 0, 0, 1, dx, dy) and an identity marks "reflow here".
export type Matrix6 = readonly [number, number, number, number, number, number];

// pixel-precision (app.render-wasm.api): the axes the pixel grid rounds.
export const PIXEL_PRECISION = {
  disabled: 0,
  both: 1,
  onlyX: 2,
  onlyY: 3,
} as const;

export type SnapIgnoreAxis = "x" | "y" | null | undefined;

// One structural edit: remove or insert a child at `index`, or scale the
// subtree content by `value` (StructureEntryType in the renderer).
export interface StructureModifier {
  type: EnumValue;
  parent: string;
  id: string;
  index?: number | null;
  value?: number;
}

// One transform to propagate. `kind` defaults to "child", the case that asks
// the renderer to spread the transform to the shape's children; "parent"
// marks a transform the renderer already spread (do not spread again).
export interface TransformModifier {
  id: string;
  transform: Matrix6;
  kind?: EnumValue;
}

// The render request the modifier protocol raises. Kept structural so the
// engine does not depend on the loop class (RenderLoop satisfies it).
export interface ModifiersRenderSink {
  requestRender(reason: string): unknown;
}

function writeUuid(view: DataView, offset: number, id: string): number {
  const quartet = uuidToU32(id);
  for (let index = 0; index < 4; index += 1) {
    view.setUint32(offset + index * 4, quartet[index], true);
  }
  return offset + 16;
}

// pixel-precision-mode: snapping off wins over either ignored axis.
export function pixelPrecision(
  snapPixel: boolean,
  ignoreAxis?: SnapIgnoreAxis,
): number {
  if (!snapPixel) return PIXEL_PRECISION.disabled;
  if (ignoreAxis === "x") return PIXEL_PRECISION.onlyY;
  if (ignoreAxis === "y") return PIXEL_PRECISION.onlyX;
  return PIXEL_PRECISION.both;
}

// set-structure-modifiers: pushes the structural edits the next propagation
// should apply. The renderer groups them by parent and replaces the override
// map, so the caller must send the whole set.
export function setStructureModifiers(
  module: RenderWasmModule,
  entries: readonly StructureModifier[],
): void {
  if (!ready() || entries.length === 0) return;

  // Resolve every type before touching the heap: an unknown one would leave
  // an allocation behind that nothing consumes.
  const types = entries.map((entry) => {
    const type = translateStructureModifierType(entry.type);
    if (type === undefined) {
      // The CLJS `case` falls through to nil, which the Rust reader turns
      // into an `unreachable!` trap; fail where the cause is still visible.
      throw new EngineError(
        "wasm-critical",
        `render-wasm: unknown structure modifier type "${nameOf(entry.type)}"`,
        { fn: "_set_structure_modifiers" },
      );
    }
    return type;
  });

  const offset = alloc(module, STRUCTURE_MODIFIER_U8_SIZE * entries.length);
  const view = dataView(heapU8(module));
  let at = offset;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    view.setUint32(at, types[index], true);
    view.setUint32(at + 4, entry.index ?? 0, true);
    at = writeUuid(view, at + 8, entry.parent);
    at = writeUuid(view, at, entry.id);
    view.setFloat32(at, entry.value ?? 0, true);
    at += 4;
  }

  call(module, "_set_structure_modifiers");
}

// set-modifiers: replaces the transform overrides of the next render. The
// whole move set goes in one allocation; an empty set is a no-op, not a
// clear (that is `cleanModifiers`).
export function setModifiers(
  module: RenderWasmModule,
  modifiers: ReadonlyArray<readonly [string, Matrix6]>,
  sink?: ModifiersRenderSink,
): void {
  if (!ready() || modifiers.length === 0) return;

  const offset = alloc(module, MODIFIER_U8_SIZE * modifiers.length);
  const view = dataView(heapU8(module));
  let at = offset;

  for (const [id, matrix] of modifiers) {
    at = writeUuid(view, at, id);
    for (let index = 0; index < 6; index += 1) {
      view.setFloat32(at, matrix[index], true);
      at += 4;
    }
  }

  call(module, "_set_modifiers");
  sink?.requestRender("set-modifiers");
}

// clean-modifiers: drops every active override. No render is requested here;
// the caller decides when the base geometry goes back on screen.
export function cleanModifiers(module: RenderWasmModule): void {
  if (!ready()) return;
  call(module, "_clean_modifiers");
}

// set-modifiers-start: enter interactive transform mode (fast-mode effect
// skipping plus the atlas backdrop, so tiles do not flicker mid-gesture).
export function setModifiersStart(module: RenderWasmModule): void {
  if (!ready()) return;
  call(module, "_set_modifiers_start");
}

// set-modifiers-end: leave interactive transform mode. Pending async renders
// scheduled under it are cancelled; the caller requests the final render.
export function setModifiersEnd(module: RenderWasmModule): void {
  if (!ready()) return;
  call(module, "_set_modifiers_end");
}

// propagate-modifiers: sends the root transforms, gets back the matrix of
// every shape the renderer moved (layout reflow and constraint spread run
// inside wasm). Always returns an array; a dead context or an empty input
// answers [] so callers never receive nil.
export function propagateModifiers(
  module: RenderWasmModule,
  entries: readonly TransformModifier[],
  snapPixel = false,
  ignoreAxis: SnapIgnoreAxis = null,
): Array<[string, Matrix6]> {
  if (!ready() || entries.length === 0) return [];

  const offset = alloc(module, INPUT_MODIFIER_U8_SIZE * entries.length);
  const view = dataView(heapU8(module));
  let at = offset;

  for (const entry of entries) {
    at = writeUuid(view, at, entry.id);
    for (let index = 0; index < 6; index += 1) {
      view.setFloat32(at, entry.transform[index], true);
      at += 4;
    }
    view.setUint32(at, translateTransformEntryKind(entry.kind ?? "child") ?? 0, true);
    at += 4;
  }

  const precision = pixelPrecision(snapPixel, ignoreAxis);
  const result = offset32(call<number>(module, "_propagate_modifiers", precision));

  // The renderer allocated the result, which can grow (and detach) the heap.
  const words = heapU32(module);
  const floats = heapF32(module);
  const count = words[result];

  const out: Array<[string, Matrix6]> = [];
  let cursor = result + 1;
  for (let index = 0; index < count; index += 1) {
    const id = u32ToUuid(
      words[cursor],
      words[cursor + 1],
      words[cursor + 2],
      words[cursor + 3],
    );
    const matrix: Matrix6 = [
      floats[cursor + 4],
      floats[cursor + 5],
      floats[cursor + 6],
      floats[cursor + 7],
      floats[cursor + 8],
      floats[cursor + 9],
    ];
    out.push([id, matrix]);
    cursor += OUTPUT_MODIFIER_U32_SIZE;
  }

  // Copy first, then release: the next allocation reuses this block.
  free(module);
  return out;
}