// app.common.render-wasm.serialize-shape + app.wasm.serialize, Node side.
//
// The call sequencing that loads one shape (or a whole scene) into the WASM
// design state. Every byte layout lives in the serializers, so the bytes are
// the editor's; only the host-specific parts stay here: fills/strokes (image
// bytes are provisioned separately) and text content (fonts provisioned
// separately). SVG-derived fills/blur/shadows are applied first, from the same
// `app.common.render-wasm.svg-derived` port the workspace uses.
//
// Mirrors `common/.../serialize_shape.cljs` and `exporter/src/app/wasm/serialize.cljs`.

import { raise } from "../errors.js";
import { call } from "./call.js";
import { writeShapeFills, writeShapeStrokes, setShapeSvgAttrs, setShapePath } from "./props.js";
import { applySvgDerived } from "./svg-derived.js";
import { setShapeText, type TextContent } from "./text.js";
import { setShapeUpload, type Shape } from "./upload.js";
import { module, type WasmModule } from "../wasm.js";

export interface SerializeOptions {
  // Override point for tests; production uses the shared derivation.
  applySvgDerived?: (shape: Shape) => Shape;
}

function pathBytes(content: unknown): Uint8Array | ArrayBuffer {
  if (content instanceof Uint8Array || content instanceof ArrayBuffer) return content;
  return raise({
    type: "internal",
    code: "path-content-not-bytes",
    hint: "path content must be the penpot/path-data byte blob",
  });
}

export function needsShapeTail(shape: Shape): boolean {
  if (shape["svg-attrs"] !== undefined) return true;
  const hasContent = shape.content !== undefined && shape.content !== null;
  return (shape.type === "path" || shape.type === "bool") && hasContent;
}

// Per-shape svg-attrs/path tail after a structural upload.
function writeShapeTail(shape: Shape, target: WasmModule): void {
  if (shape["svg-attrs"] !== undefined) setShapeSvgAttrs(shape["svg-attrs"], target);

  if ((shape.type === "path" || shape.type === "bool") && shape.content !== undefined && shape.content !== null) {
    setShapePath(pathBytes(shape.content), target);
  }
}

// Applies every host-independent WASM property of `shape` and returns the
// prepared shape for the host-specific steps.
export function serializeShape(
  shape: Shape,
  options: SerializeOptions = {},
  target: WasmModule = module(),
): Shape {
  const prepared = (options.applySvgDerived ?? applySvgDerived)(shape);

  setShapeUpload(prepared, { includeLayout: false }, target);
  if (needsShapeTail(prepared)) writeShapeTail(prepared, target);

  return prepared;
}

export function setShape(
  shape: Shape,
  options: SerializeOptions = {},
  target: WasmModule = module(),
): void {
  const prepared = serializeShape(shape, options, target);

  writeShapeFills(prepared.fills, target);
  if (prepared.type !== "group") writeShapeStrokes(prepared.strokes, target);
  if (prepared.type === "text") setShapeText(prepared.content as TextContent, target);
}

// Loads every shape of an `objects` map. The shape pool is reset first so
// repeated exports do not accumulate into the shared state. Order does not
// matter: shapes reference each other by id and the tree is resolved at
// render time.
export function serializeScene(
  objects: Record<string, Shape>,
  options: SerializeOptions = {},
  target: WasmModule = module(),
): void {
  const shapes = Object.values(objects);
  call(target, "_init_shapes_pool", shapes.length);
  for (const shape of shapes) setShape(shape, options, target);
}
