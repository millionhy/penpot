// ClojureScript interop helpers shared by every render-wasm consumer. The
// compiled frontend (public/js/shared.js) exposes one object, $APP, whose
// keys are munged ClojureScript symbols; these helpers hide the munging and
// the multi-arity dispatch so call sites read like the CLJS originals.

// The compiled frontend namespace object. Every symbol lives under its
// munged name (e.g. $app$main$render_viewer_wasm$render_to_canvas$$);
// callers reach the ones they need by key, so the type stays opaque here.
export type RendererApp = Record<string, unknown>;

type CljsFn = (...args: unknown[]) => unknown;

interface PAMConstructor {
  new (meta: unknown, cnt: number, arr: unknown[], hash: unknown): unknown;
}

// $APP keys, verbatim from public/js/shared.js. Each entry was read from the
// compiled artifact; the $0 segments are part of the shadow-cljs escaping
// and must not be "fixed".
export const KEY = {
  // shadow-cljs module delay + the wasm lifecycle (app.render-wasm.*)
  moduleDelay: "$app$render_wasm$api$module$$",
  internalModule: "$app$render_wasm$wasm$internal_module$$",
  initCanvasContext: "$app$render_wasm$api$init_canvas_context$$",
  initializeViewport:
    "$app$render_wasm$api$initialize_viewport$cljs$0core$0IFn$0_invoke$0arity$0variadic$$",
  setRulersFrameVisible: "$app$render_wasm$api$set_rulers_frame_visible_BANG_$$",
  setRulersVisible: "$app$render_wasm$api$set_rulers_visible_BANG_$$",
  requestRender: "$app$render_wasm$api$request_render$$",
  getDpr: "$app$render_wasm$api$get_dpr$$",
  // set-view-box: a $APP member in this build (probe-verified against the
  // compiled artifact). The interaction bookkeeping (fast mode, from-cache
  // preview, debounced finalize with the progressive continuation) lives
  // inside it, so the workspace viewport calls it as-is. It reads the vbox
  // with (:x vbox), hence the PersistentArrayMap the callers pass.
  setViewBox: "$app$render_wasm$api$set_view_box$$",
  // Multi-arity vars export one entry per arity and the whole munged name
  // IS the key; call() invokes the extracted method directly (see below).
  resizeCanvas: "$app$render_wasm$api$resize_canvas_BANG_$cljs$0core$0IFn$0_invoke$0arity$02$$",
  clearCanvas: "$app$render_wasm$api$clear_canvas$cljs$0core$0IFn$0_invoke$0arity$01$$",
  wasmLive: "$app$render_wasm$wasm$live_QMARK_$$",
  wasmReady: "$app$render_wasm$wasm$ready_QMARK_$$",
  // The fixed-scroll layer mask (viewer-apply-layer-mask!) has no entry
  // point on $APP: runtime-verified, clear/set-render-include-filter! are
  // both undefined (the optimizer inlined them). The empty-mask reset is
  // replicated through the internal module in pass-common.ts; the id paths
  // land with the fixed-layer slice. set_shape_fills / set_shape_strokes DO
  // land on $APP (registered below); an earlier probe note that listed them
  // as inlined was wrong.
  // The rAF handle of a scheduled render (set! to null cancels the handle
  // bookkeeping, mirrors the compiled set! wasm/internal-frame-id nil).
  internalFrameId: "$app$render_wasm$wasm$internal_frame_id$$",

  // --- F9.5 shape writes (app.render-wasm.api) ---
  // Only set_object is exported in this build (runtime-probed: the $APP
  // entry exists and is a function). It writes one whole shape record: base
  // props, children list and the host attrs (fills/strokes included). It
  // also leaves that shape current, so every write path goes through it.
  // set_shape_children / set_shape_fills / set_shape_strokes /
  // set_shape_opacity / set_shape_hidden / set_shape_corners exist as
  // top-level vars in public/js/shared.js but carry no $APP entry: calling
  // one throws "is not a function". See lib/render-wasm/shape-upload.ts.
  setObject: "$app$render_wasm$api$set_object$$",

  // cljs.core
  deref: "$cljs$core$_deref$$",
  get: "$cljs$core$get$$",
  keyword: "$cljs$core$keyword$$",
  name: "$cljs$core$name$$",
  seq: "$cljs$core$seq$$",
  first: "$cljs$core$first$$",
  next: "$cljs$core$next$$",
  val: "$cljs$core$val$$",
  assoc: "$cljs$core$assoc$$",
  str: "$cljs$core$str$$",
  vec: "$cljs$core$vec$$",
  persistentArrayMap: "$cljs$core$PersistentArrayMap$$",

  // app.common
  decodeStr: "$app$common$transit$decode_str$$",
  uuidParse: "$app$common$uuid$parse$$",
  pointerQmark: "$app$common$transit$pointer_QMARK_$$",
  getObjectBounds: "$app$common$geom$shapes$bounds$get_object_bounds$$",
  textShapeQmark: "$app$common$files$helpers$text_shape_QMARK_$$",
  // gsh/transform-str. A multi-arity var: the dispatcher carries its
  // $cljs$core$IFn$_invoke$arity$N$ properties (with the $ wrapping of this
  // build) and switches on arguments.length, so call()'s direct fallback
  // runs the 1-arg form (verified at runtime by the F6.5 probe).
  transformStr: "$app$common$geom$shapes$transform_str$$",

  // --- F9.2 probe: canvas-interaction reuse surface (public/js/shared.js) ---
  // Available on $APP, registered below: app.common.types.shape-tree
  // sort-z-index (arities 2 and 3; F9.2 calls arity 3 with the
  // bottom-frames? options map) and top-nested-frame (arity 4), for hover
  // ordering and frame resolution; app.common.files.helpers
  // get-immediate-children (arity 2 and 3), get-children-ids,
  // get-children-ids-with-self, get-parent-ids, frame-shape?, root-frame?,
  // group-shape?, group-like-shape? (arity 1), mask-shape?, svg-raw-shape?,
  // is-direct-child-of-root? (arity 1); app.common.types.component
  // instance-head? and main-instance?. sort-z-index-objects stayed local
  // (both arities) and is not registered.
  // Inlined away (absent from $APP; ported to TypeScript instead):
  // app.common.geom.shapes.intersect/overlaps?, rect-contains-shape? and
  // overlaps-path? -> lib/workspace-index.ts; app.common.geom.shapes.text/
  // shape->bounds -> same port (shape->rect IS on $APP, but it skips the
  // shape transform and transform-matrix is inlined too, so the port
  // applies the matrix itself); app.common.files.helpers/hidden-parent? and
  // get-parents-with-self -> lib/workspace-selection.ts; app.common.files
  // .indices/generate-child-all-parents-index and create-clip-index ->
  // workspace-index.ts; app.render-wasm.api/intersect-position-in-shape ->
  // replicated below through the internal module.
  sortZIndexArity2:
    "$app$common$types$shape_tree$sort_z_index$cljs$0core$0IFn$0_invoke$0arity$02$$",
  sortZIndexArity3:
    "$app$common$types$shape_tree$sort_z_index$cljs$0core$0IFn$0_invoke$0arity$03$$",
  topNestedFrame:
    "$app$common$types$shape_tree$top_nested_frame$cljs$0core$0IFn$0_invoke$0arity$04$$",
  getImmediateChildrenArity2:
    "$app$common$files$helpers$get_immediate_children$cljs$0core$0IFn$0_invoke$0arity$02$$",
  getImmediateChildrenArity3:
    "$app$common$files$helpers$get_immediate_children$cljs$0core$0IFn$0_invoke$0arity$03$$",
  getChildrenIds: "$app$common$files$helpers$get_children_ids$$",
  getChildrenIdsWithSelf: "$app$common$files$helpers$get_children_ids_with_self$$",
  getParentIds: "$app$common$files$helpers$get_parent_ids$$",
  frameShapeQmark: "$app$common$files$helpers$frame_shape_QMARK_$$",
  rootFrameQmark: "$app$common$files$helpers$root_frame_QMARK_$$",
  groupShapeQmark: "$app$common$files$helpers$group_shape_QMARK_$$",
  groupLikeShapeQmark:
    "$app$common$files$helpers$group_like_shape_QMARK_$cljs$0core$0IFn$0_invoke$0arity$01$$",
  maskShapeQmark: "$app$common$files$helpers$mask_shape_QMARK_$$",
  svgRawShapeQmark: "$app$common$files$helpers$svg_raw_shape_QMARK_$$",
  isDirectChildOfRootQmark:
    "$app$common$files$helpers$is_direct_child_of_root_QMARK_$cljs$0core$0IFn$0_invoke$0arity$01$$",
  instanceHeadQmark: "$app$common$types$component$instance_head_QMARK_$$",
  mainInstanceQmark: "$app$common$types$component$main_instance_QMARK_$$",
  // app.common.geom.point/point. Constructs the position argument the
  // compiled tree functions read with dm/get-prop (a CLJS point record).
  point: "$app$common$geom$point$point$$",

  // app.main.ui.viewer.viewport-common. prepare-objects is the only member
  // on $APP: prepare-page-objects and viewer-scale were inlined by the
  // optimizer (runtime-probed undefined) and the port prepares one frame at
  // a time instead. See lib/render-wasm/viewer-shapes.ts.
  prepareObjects: "$app$main$ui$viewer$viewport_common$prepare_objects$$",

  // app.render-wasm / app.main.render-viewer-wasm
  calculatePositionData: "$app$render_wasm$api$calculate_position_data$$",
  // The app.main.render-viewer-wasm namespace (render-to-canvas,
  // draw-bitmap!, render-sync-shape, enqueue-wasm-render!, ...) is
  // closure-private: ADVANCED inlined it and no key of it lands on $APP
  // (verified against the compiled artifact and at runtime). The one-shot
  // frame render is rebuilt from the public api primitives in
  // lib/render-wasm/frame-render.ts.
} as const;

function fn(app: RendererApp, name: string): CljsFn {
  const value = app[name];
  if (typeof value !== "function") {
    throw new Error(`render-wasm: $APP["${name}"] is not a function`);
  }
  return value as CljsFn;
}

// Multi-arity CLJS vars compile to a dispatcher carrying one
// `cljs$core$IFn$_invoke$arity$N` method per arity; the compiled code calls
// those methods directly. Prefer the same shape and fall back to the
// dispatcher itself (single-arity vars and extracted primitive methods such
// as the variadic initialize-viewport are plain callables).
export function call(app: RendererApp, name: string, ...args: unknown[]): unknown {
  const target = fn(app, name);
  const method = (target as unknown as Record<string, unknown>)[
    `cljs$core$IFn$_invoke$arity$${args.length}`
  ];
  if (typeof method === "function") return (method as CljsFn)(...args);
  return target(...args);
}

// Keywords intern in the CLJS runtime, so a runtime-built keyword is
// identical to the compiled cst constants the decoded payload carries.
export function keyword(app: RendererApp, name: string): unknown {
  return call(app, KEY.keyword, name);
}

// CLJS nil is JS null, so a missing key answers null here.
export function get(app: RendererApp, coll: unknown, key: unknown): unknown {
  return call(app, KEY.get, coll, key);
}

export function uuid(app: RendererApp, id: string): unknown {
  return call(app, KEY.uuidParse, id);
}

// A CLJS PersistentArrayMap built from key/value pairs: the shape the
// compiled code passes around as option maps. PersistentArrayMap counts
// entries, not array slots (fromArray uses arr.length / 2, _iterator uses
// cnt * 2), so the constructor gets the pair count.
export function arrayMap(
  app: RendererApp,
  entries: ReadonlyArray<readonly [unknown, unknown]>,
): unknown {
  const arr: unknown[] = [];
  for (const [k, v] of entries) arr.push(k, v);
  const Ctor = app[KEY.persistentArrayMap] as PAMConstructor;
  return new Ctor(null, entries.length, arr, null);
}

// A CLJS vector from a JS array (cljs.core/vec), for $APP functions whose
// collection arguments are compiled-cljs values (e.g. sort-z-index's id
// list).
export function vec(app: RendererApp, items: readonly unknown[]): unknown {
  return call(app, KEY.vec, items);
}

// The four big-endian u32 words of a uuid string, the shape the wasm ABI
// takes. Mirrors uuid/get-u32 (getUnsignedParts in
// common/src/app/common/uuid_impl.js): every 8 hex digits of the dashless
// string read as one big-endian u32.
export function uuidToU32(id: string): [number, number, number, number] {
  const hex = id.replace(/-/g, "");
  return [
    Number.parseInt(hex.slice(0, 8), 16),
    Number.parseInt(hex.slice(8, 16), 16),
    Number.parseInt(hex.slice(16, 24), 16),
    Number.parseInt(hex.slice(24, 32), 16),
  ];
}

// app.render-wasm.api/intersect-position-in-shape: whether the already
// loaded shape's rendered area contains the position (the workspace hover
// uses it to filter text shapes over their glyph outlines). The $APP entry
// point was inlined by the optimizer (F9.2 probe), so this replicates the
// body: one internal call — the four uuid words plus the position —
// answering 1 when inside. The original's initialized? guard is
// wasm/ready?; the same wasmReady gate runs here and a not-ready renderer
// answers false (no glyphs are laid out).
export function intersectPositionInShape(
  app: RendererApp,
  id: string,
  x: number,
  y: number,
): boolean {
  if (call(app, KEY.wasmReady) !== true) return false;
  const [a, b, c, d] = uuidToU32(id);
  const internal = app[KEY.internalModule] as Record<string, (...args: number[]) => unknown>;
  return internal._intersect_position_in_shape(a, b, c, d, x, y) === 1;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
