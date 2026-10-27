// F9.11: the shell side of a layout reflow.
//
// The layout math is not here. The renderer owns it (render-wasm/src/shapes/
// modifiers.rs reflow_flex_layout / reflow_grid_layout) and the shell asks
// for it with an identity transform, the "reflow this" mark. This module
// decides which attribute edits need that request, builds the entry list and
// turns the returned matrices into update-file changes.
//
// Trigger set: the layout attributes only. A layout-item edit reflows the
// parent, a grid cell edit reflows the grid, and creating or removing a
// layout reflows the frame itself. The renderer walks up from the edited id
// to the nearest layout ancestor, so the target is the edited shape, not its
// parent. The constraint attributes do not reflow: they act on a resize, and
// that path already sends its own transform.

import { ZERO_UUID } from "@/lib/file-data";
import type { UpdateFileModObjChange } from "@/lib/transit";
import type { WorkspaceObjects } from "@/lib/workspace";
import {
  IDENTITY_MATRIX,
  applyTransformEntries,
  buildTransformEntryChanges,
  type Matrix6,
  type TransformEntry,
} from "@/lib/workspace-transform";

// The single prefix the reflow reacts to: :layout itself, layout-gap,
// layout-padding, layout-item-*, layout-grid-*, layout-align-*, ...
const REFLOW_PREFIX = "layout";

export interface ReflowUpdate {
  readonly id: string;
  readonly attrs: Readonly<Record<string, unknown>>;
}

// Whether a committed attribute map changes how a layout arranges its
// children. `layout` counts on its own (a flex/grid layout was added, swapped
// or removed); every prefixed key counts too.
export function attrsAskReflow(attrs: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(attrs).some(
    (attr) => attr === REFLOW_PREFIX || attr.startsWith(`${REFLOW_PREFIX}-`),
  );
}

// The shapes to ask the renderer to reflow: the edited ones, minus the root
// board (it lays out nothing) and minus the ids the model no longer has.
// Duplicates collapse: two edits of one container ask for one reflow.
export function reflowTargetIds(
  objects: WorkspaceObjects,
  updates: readonly ReflowUpdate[],
): string[] {
  const ids = new Set<string>();
  for (const update of updates) {
    if (!attrsAskReflow(update.attrs)) continue;
    if (update.id === ZERO_UUID) continue;
    if (objects[update.id] === undefined || objects[update.id] === null) continue;
    ids.add(update.id);
  }
  return [...ids];
}

// The entries of one reflow request: the identity matrix for every target.
// An identity is not a no-op in the renderer; it becomes Modifier::Reflow.
export function reflowEntries(ids: readonly string[]): TransformEntry[] {
  return ids.map((id) => ({ id, matrix: IDENTITY_MATRIX, rotation: 0 }));
}

// The mod-obj changes of a reflow result. The matrices come from the
// renderer, relative to the committed geometry, so they apply as they are.
// Shapes that do not move produce no change (buildTransformEntryChanges drops
// an empty patch), which keeps a reflow that changes nothing out of the file.
export function reflowChanges(
  objects: WorkspaceObjects,
  transforms: ReadonlyArray<readonly [string, Matrix6]>,
  pageId: string,
): UpdateFileModObjChange[] {
  return buildTransformEntryChanges(
    objects,
    transforms.map(([id, matrix]) => ({ id, matrix, rotation: 0 })),
    pageId,
  );
}

// The local mirror of reflowChanges: one apply-transform per returned shape.
export function applyReflow(
  objects: WorkspaceObjects,
  transforms: ReadonlyArray<readonly [string, Matrix6]>,
): WorkspaceObjects {
  return applyTransformEntries(
    objects,
    transforms.map(([id, matrix]) => ({ id, matrix, rotation: 0 })),
  );
}
