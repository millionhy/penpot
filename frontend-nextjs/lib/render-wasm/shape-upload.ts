// The incremental wasm upload of new, transformed and restyled shapes (F9.5
// AD5, F9.6 T4).
//
// Every write goes through set_object. This build exports only a few
// app.render-wasm.api vars on $APP: set_object and use_shape are there, but
// set_shape_children, set_shape_fills, set_shape_strokes, set_shape_opacity,
// set_shape_hidden and set_shape_corners are not (runtime-probed against
// public/js/shared.js: the vars exist, the $APP entries do not). A call to a
// missing key throws, the caller can only warn, and the canvas keeps the old
// pixels while the store already shows the new value.
//
// set_object writes the whole record in one FFI: base props (opacity,
// hidden, blend mode, selrect, transform, rotation, r1..r4) plus the children
// list, then the host attrs (layout, layout item, constraints, text, fills,
// strokes). Each call leaves that shape current. An add-obj commit is
// therefore set_object(new) ->
// set_object(parent, whose record carries the new children list) ->
// request_render. No initialize-viewport and no render_sync_shape: the
// renderer adds tiles for shapes missing from its tile set.
//
// A committed resize/rotate reuses set_object per transformed shape: the
// record carries the new selrect, points, rotation, transform and flips,
// while the selrect-only geometry push of the move path would drop the
// rotation. One request_render follows the loop.
//
// Every value crosses the boundary through transit: encodeShapeValue
// produces the same wire form the update-file payload uses (keyword keys,
// uuid tags, record tags) and decode_str rebuilds the CLJS maps and UUID
// objects the wasm api reads. A second hand-written converter would drift
// from the serialized shape.

import {
  encodeShapeValue,
  encodeTransit,
  type UpdateFileChange,
} from "@/lib/transit";
import { KEY, call, type RendererApp } from "@/lib/render-wasm/interop";

// One shape map as a CLJS Shape record.
export function cljsShape(
  app: RendererApp,
  shape: Readonly<Record<string, unknown>>,
): unknown {
  return call(app, KEY.decodeStr, encodeTransit(encodeShapeValue(shape)));
}

export function uploadNewShape(
  app: RendererApp,
  shape: Readonly<Record<string, unknown>>,
  parentShape: Readonly<Record<string, unknown>> | undefined,
): void {
  if (typeof shape["parent-id"] !== "string") {
    throw new Error("shape-upload: the shape has no parent-id to attach it to");
  }

  // The parent record carries the new children list, so the tree sees the
  // added shape without the missing set_shape_children entry point. A root
  // parent has no record in the model, so there is nothing to write for it.
  call(app, KEY.setObject, cljsShape(app, shape));
  if (parentShape !== undefined) call(app, KEY.setObject, cljsShape(app, parentShape));
  call(app, KEY.requestRender, null);
}

// Push the committed geometry of a resize/rotate (F9.6): one set_object per
// transformed shape, so the pool sees the new rotation, transform and
// flips, and one request_render after the loop. The caller leaves the
// modifier preview first (end_modifiers + clean_modifiers) in the same
// task, so no frame shows the stale base geometry. A wasm failure is the
// caller's to warn about: the file already accepted the change.
export function uploadShapeGeometry(
  app: RendererApp,
  shapes: ReadonlyArray<Readonly<Record<string, unknown>>>,
): void {
  for (const shape of shapes) {
    call(app, KEY.setObject, cljsShape(app, shape));
  }
  call(app, KEY.requestRender, null);
}

// Push the result of an undo/redo commit (F9.7). The changes decide what
// moved: every parent whose children list changed is rewritten through
// set_object (its record carries the new list, so a deleted shape stops
// being drawn and a re-parented one moves), then every shape that still
// exists is rewritten through set_object (the full record keeps rotation,
// transform and flips). The previous model supplies the old parents for
// del-obj and mov-objects; the next model supplies the children lists and
// the shape records. One request_render closes the batch.
export function uploadChangedShapes(
  app: RendererApp,
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

  // Parents first: their record carries the children list, so a deleted
  // shape stops being drawn and a re-parented one moves. A parent that is
  // also in `shapes` needs no second write.
  for (const parentId of parents) {
    const parent = after[parentId];
    if (parent === undefined) continue;
    call(app, KEY.setObject, cljsShape(app, parent));
    shapes.delete(parentId);
  }

  for (const id of shapes) {
    const shape = after[id];
    if (shape !== undefined) call(app, KEY.setObject, cljsShape(app, shape));
  }

  call(app, KEY.requestRender, null);
}

// The attribute prefixes the renderer reads off the shape record. A layout
// container, a layout item (layout-item-*) and a constrained child all
// change pixels or placement, so a commit that carries one rewrites the
// record. The constraints travel inside the record like every other host
// attr; the reflow itself waits for the next modifier of the parent.
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
    // A shadow list or a nil (the removal) both rewrite the record;
    // the same holds for the single blur map.
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
  app: RendererApp,
  shape: Readonly<Record<string, unknown>>,
  attrs: Readonly<Record<string, unknown>>,
): boolean {
  if (!attrsWriteStyle(attrs)) return false;

  call(app, KEY.setObject, cljsShape(app, shape));
  call(app, KEY.requestRender, null);
  return true;
}
