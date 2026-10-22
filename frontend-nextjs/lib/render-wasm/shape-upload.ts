// The incremental wasm upload of one new shape (F9.5 AD5).
//
// set_object writes a shape record (and its fills/strokes) and leaves that
// shape current; use_shape switches the current shape; set_shape_children
// rewrites the current shape's children. An add-obj commit therefore needs
// set_object(new) -> use_shape(parent) -> set_shape_children(parent children)
// -> request_render. No initialize-viewport and no render_sync_shape: the
// renderer adds tiles for shapes missing from its tile set.
//
// Every value crosses the boundary through transit: encodeShapeValue /
// encodeAttrValue produce the same wire form the update-file payload uses
// (keyword keys, uuid tags, record tags) and decode_str rebuilds the CLJS
// maps and UUID objects the wasm api reads. A second hand-written converter
// would drift from the serialized shape.

import {
  encodeAttrValue,
  encodeShapeValue,
  encodeTransit,
} from "@/lib/transit";
import {
  KEY,
  call,
  uuid,
  vec,
  type RendererApp,
} from "@/lib/render-wasm/interop";

// A plain JS value as the CLJS map/vector the wasm api reads. The reader
// keeps keywords as keywords, uuids as UUID instances and records as the
// decoded values, exactly like the update-file payload on the wire.
export function cljsValue(app: RendererApp, value: unknown): unknown {
  return call(app, KEY.decodeStr, encodeTransit(encodeAttrValue(value)));
}

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
  parentChildren: readonly string[],
): void {
  const parentId = shape["parent-id"];
  if (typeof parentId !== "string") {
    throw new Error("shape-upload: the shape has no parent-id to attach it to");
  }

  // set_object already calls use_shape and writes fills/strokes, so the
  // setters are deliberately not called again here.
  call(app, KEY.setObject, cljsShape(app, shape));
  call(app, KEY.useShape, uuid(app, parentId));
  call(app, KEY.setShapeChildren, vec(app, parentChildren.map((id) => uuid(app, id))));
  call(app, KEY.requestRender, null);
}

// Push the wasm-visible subset of a style edit (hidden, opacity, fills,
// strokes, r1..r4). The other attributes (blocked, for example) only feed
// the editor and the DOM, so a call with none of the visible ones performs
// no wasm call and answers false.
export function applyShapeStyle(
  app: RendererApp,
  id: string,
  attrs: Readonly<Record<string, unknown>>,
): boolean {
  const hidden = attrs.hidden;
  const opacity = attrs.opacity;
  const fills = attrs.fills;
  const strokes = attrs.strokes;
  const corners = [attrs.r1, attrs.r2, attrs.r3, attrs.r4];

  const writesHidden = typeof hidden === "boolean";
  const writesOpacity = typeof opacity === "number";
  const writesFills = Array.isArray(fills);
  const writesStrokes = Array.isArray(strokes);
  const writesCorners = corners.every((value) => typeof value === "number");

  if (!writesHidden && !writesOpacity && !writesFills && !writesStrokes && !writesCorners) {
    return false;
  }

  const shapeId = uuid(app, id);
  call(app, KEY.useShape, shapeId);
  if (writesHidden) call(app, KEY.setShapeHidden, hidden);
  if (writesOpacity) call(app, KEY.setShapeOpacity, opacity);
  // The shape id on these two only feeds image fetches; the records go to
  // the current shape (use_shape above).
  if (writesFills) call(app, KEY.setShapeFills, shapeId, cljsValue(app, fills), false);
  if (writesStrokes) call(app, KEY.setShapeStrokes, shapeId, cljsValue(app, strokes), false);
  if (writesCorners) call(app, KEY.setShapeCorners, vec(app, corners));
  call(app, KEY.requestRender, null);
  return true;
}
