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
  // point on $APP: runtime-verified, clear/set-render-include-filter! and
  // clear/set-shape-fills are all undefined (the optimizer inlined them).
  // The empty-mask reset is replicated through the internal module in
  // pass-common.ts; the id paths land with the fixed-layer slice.
  // The rAF handle of a scheduled render (set! to null cancels the handle
  // bookkeeping, mirrors the compiled set! wasm/internal-frame-id nil).
  internalFrameId: "$app$render_wasm$wasm$internal_frame_id$$",

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
// compiled code passes around as option maps.
export function arrayMap(
  app: RendererApp,
  entries: ReadonlyArray<readonly [unknown, unknown]>,
): unknown {
  const arr: unknown[] = [];
  for (const [k, v] of entries) arr.push(k, v);
  const Ctor = app[KEY.persistentArrayMap] as PAMConstructor;
  return new Ctor(null, arr.length, arr, null);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
