// The incremental wasm upload of new, transformed and restyled shapes
// (F9.5 AD5, F9.6 T4), over the TypeScript engine (G4.6b).
//
// Every write goes through `set_object` and carries the whole shape record
// plus its host attrs. The engine's `setObject` writes the base props
// (opacity, hidden, blend mode, selrect, transform, rotation, r1..r4) and the
// children list, then hands the prepared record to `onShape`, which writes
// the layout, fills, strokes, text and grid data. The incremental call is
// the exact counterpart of the compiled `api/set-object`, whose host pass
// runs with neither `skip-layout?` nor `skip-fills-strokes?`.
//
// Consequences of that pairing:
// - An add-obj commit is set_object(new) -> set_object(parent, whose record
//   carries the new children list) -> request_render. No initialize-viewport
//   and no render_sync_shape: the renderer adds tiles for shapes missing from
//   its tile set.
// - A committed resize/rotate reuses set_object per transformed shape: the
//   record carries the new selrect, points, rotation, transform and flips,
//   while a selrect-only geometry push would drop the rotation.
// - The record travels as the plain model object. The engine's serializers
//   read the same keyword-named fields the transit payload carries, so the
//   compiled encode/decode round trip is no longer needed.

import {
  setObject,
  type Shape,
} from "@/lib/render-wasm/engine";
import type { UpdateFileChange } from "@/lib/transit";
import type { WorkspaceApp } from "@/lib/render-wasm/workspace-app";

// The model shape and the engine record share the field names; the index
// signature of WorkspaceShape makes the structural cast explicit.
function renderShape(shape: Readonly<Record<string, unknown>>): Shape {
  return shape as unknown as Shape;
}

function pushShape(
  app: WorkspaceApp,
  shape: Readonly<Record<string, unknown>>,
): void {
  setObject(app.module, renderShape(shape), {
    onShape: (prepared) => app.host.hostAttrs(prepared),
  });
}

export function uploadNewShape(
  app: WorkspaceApp,
  shape: Readonly<Record<string, unknown>>,
  parentShape: Readonly<Record<string, unknown>> | undefined,
): void {
  if (typeof shape["parent-id"] !== "string") {
    throw new Error("shape-upload: the shape has no parent-id to attach it to");
  }

  // The parent record carries the new children list, so the tree sees the
  // added shape. A root parent has no record in the model, so there is
  // nothing to write for it.
  pushShape(app, shape);
  if (parentShape !== undefined) pushShape(app, parentShape);
  app.loop.requestRender("upload-new-shape");
}

// Push the committed geometry of a resize/rotate (F9.6): one set_object per
// transformed shape, so the pool sees the new rotation, transform and flips,
// and one request_render after the loop. The caller leaves the modifier
// preview first (end_modifiers + clean_modifiers) in the same task, so no
// frame shows the stale base geometry. A wasm failure is the caller's to warn
// about: the file already accepted the change.
export function uploadShapeGeometry(
  app: WorkspaceApp,
  shapes: ReadonlyArray<Readonly<Record<string, unknown>>>,
): void {
  for (const shape of shapes) pushShape(app, shape);
  app.loop.requestRender("upload-shape-geometry");
}

// Push the result of an undo/redo commit (F9.7). The changes decide what
// moved: every parent whose children list changed is rewritten through
// set_object (its record carries the new list, so a deleted shape stops being
// drawn and a re-parented one moves), then every shape that still exists is
// rewritten through set_object (the full record keeps rotation, transform and
// flips). The previous model supplies the old parents for del-obj and
// mov-objects; the next model supplies the children lists and the shape
// records. One request_render closes the batch.
export function uploadChangedShapes(
  app: WorkspaceApp,
  before: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  after: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  changes: readonly UpdateFileChange[],
): void {
  const parents = new Set<string>();
  const shapes = new Set<string>();
  const readParent = (id: string): void => {
    const shape = before[id];
    const parentId = shape === undefined ? undefined : shape["parent-id"];
    if (typeof parentId === "string") parents.add(parentId);
  };

  for (const change of changes) {
    switch (change.type) {
      case "mod-obj":
        shapes.add(change.id);
        break;
      case "add-obj":
        shapes.add(change.id);
        parents.add(change["parent-id"]);
        break;
      case "del-obj":
        readParent(change.id);
        break;
      case "mov-objects":
        parents.add(change["parent-id"]);
        for (const id of change.shapes) {
          readParent(id);
          shapes.add(id);
        }
        break;
    }
  }

  // Parents first: their record carries the children list, so a deleted shape
  // stops being drawn and a re-parented one moves. A parent that is also in
  // `shapes` needs no second write.
  for (const parentId of parents) {
    const parent = after[parentId];
    if (parent === undefined) continue;
    pushShape(app, parent);
    shapes.delete(parentId);
  }

  for (const id of shapes) {
    const shape = after[id];
    if (shape !== undefined) pushShape(app, shape);
  }

  app.loop.requestRender("upload-changed-shapes");
}

// The attribute prefixes the renderer reads off the shape record. A layout
// container, a layout item (layout-item-*) and a constrained child all change
// pixels or placement, so a commit that carries one rewrites the record. The
// constraints travel inside the record like every other host attr; the reflow
// itself waits for the next modifier of the parent.
const WASM_ATTR_PREFIXES = ["layout", "constraints-"] as const;

// Whether a commit carries an attribute the wasm record mirrors. Exported so
// the multi-selection commit decides once whether to push a batch.
export function attrsWriteStyle(attrs: Readonly<Record<string, unknown>>): boolean {
  const corners = [attrs.r1, attrs.r2, attrs.r3, attrs.r4];
  if (
    typeof attrs.hidden === "boolean" ||
    typeof attrs.opacity === "number" ||
    Array.isArray(attrs.fills) ||
    Array.isArray(attrs.strokes) ||
    // A text typography edit rewrites :content (the whole root tree). The
    // record carries it, so one set_object re-uploads the text (D4); the
    // glyphs re-measure through the engine's text layout pass.
    attrs.content !== undefined ||
    // A shadow list or a nil (the removal) both rewrite the record; the same
    // holds for the single blur map.
    attrs.shadow !== undefined ||
    attrs.blur !== undefined ||
    corners.every((value) => typeof value === "number")
  ) {
    return true;
  }
  if (attrs["fixed-scroll"] !== undefined) return true;
  return Object.keys(attrs).some((attr) =>
    WASM_ATTR_PREFIXES.some((prefix) => attr.startsWith(prefix)),
  );
}

// Push a style edit through set_object: `shape` is the record the store now
// holds (the old record with `attrs` applied), so one payload carries hidden,
// opacity, fills, strokes, shadow, blur and r1..r4 together, and the layout
// and constraint attrs when the panel edits those sections. A nil shadow or
// blur arrives already dropped from `shape`, which makes set_object remove the
// effect. The other attributes (blocked, for example) only feed the editor and
// the DOM, so a call with none of the visible ones performs no wasm call and
// answers false.
export function applyShapeStyle(
  app: WorkspaceApp,
  shape: Readonly<Record<string, unknown>>,
  attrs: Readonly<Record<string, unknown>>,
): boolean {
  if (!attrsWriteStyle(attrs)) return false;
  pushShape(app, shape);
  app.loop.requestRender("apply-shape-style");
  return true;
}
