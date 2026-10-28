// The workspace viewport's direct-to-canvas render layer (F9.1): the port of
// the workspace branch of app.main.ui.workspace.viewport-wasm and the
// app.render-wasm.api entry points it drives. Unlike the viewer (which
// renders one frame into an offscreen canvas and blits), the workspace draws
// straight onto its visible canvas and lets the compiled progressive tile
// renderer run.
//
// The compiled build exposes the whole chain on $APP (probe-verified against
// public/js/shared.js): init-canvas-context, resize-canvas! (arity 2),
// initialize-viewport (variadic), set-view-box and clear-canvas. set-view-box
// carries the interaction bookkeeping itself — view-interaction-start!, the
// from-cache preview and the debounced finalize with its progressive
// continuation (render-finish is module-private, but set-view-box calls it
// internally), so the port calls it rather than rebuilding those pieces.
//
// Deviations from the compiled original:
// - vbox travels as a CLJS PersistentArrayMap. The compiled functions read it
//   with (:x vbox), i.e. through the Keyword IFn / ILookup protocol, which
//   does not answer plain-object lookups in this build (the compiled
//   cljs.core/get returns null for a JS object), so a plain {x, y} literal
//   would silently collapse to (0, 0).
// - No page-transition lifecycle (start-initial-load-transition! /
//   arm-page-transition-end!) and no WebGL context-loss recovery: this slice
//   renders a single page, and reload-renderer! drives off the compiled app
//   state, which this shell does not fill. A lost context stays static until
//   the page is reloaded.

import { KEY, arrayMap, call, keyword, type RendererApp } from "./interop";
import { readDpr } from "./pass-common";

export interface Point {
  x: number;
  y: number;
}

// The vbox option map of the compiled viewport functions: a CLJS keyword map,
// see the module comment.
export function vboxMap(app: RendererApp, vbox: Point): unknown {
  return arrayMap(app, [
    [keyword(app, "x"), vbox.x],
    [keyword(app, "y"), vbox.y],
  ]);
}

// init-canvas-context: registers a WebGL2 context on the visible canvas,
// initializes the renderer and sizes the drawing buffer. False when the
// module is not booted or the context cannot be created; the caller retries,
// mirroring try-init in viewport-wasm.cljs.
export function initWorkspaceCanvas(
  app: RendererApp,
  canvas: HTMLCanvasElement,
): boolean {
  return call(app, KEY.initCanvasContext, canvas) === true;
}

// resize-canvas!: drawing buffer, render options and viewbox from the canvas
// CSS size. The explicit-dpr overload (arity 2) is the one the compiled
// retina watcher uses.
export function resizeWorkspaceCanvas(
  app: RendererApp,
  canvas: HTMLCanvasElement,
  dpr?: number,
): void {
  call(app, KEY.resizeCanvas, canvas, dpr ?? readDpr(app));
}

export interface WorkspaceViewportOptions {
  background?: string;
  onShapesReady?: () => void;
}

// initialize-viewport: canvas background, view, shapes pool and the shape
// load (set-objects). Without an :on-render callback the compiled set-objects
// falls back to request-render, which drives the progressive chain.
export function initializeWorkspaceViewport(
  app: RendererApp,
  objects: unknown,
  zoom: number,
  vbox: Point,
  options: WorkspaceViewportOptions = {},
): void {
  const entries: Array<[unknown, unknown]> = [
    [keyword(app, "background-opacity"), 1],
  ];
  if (options.background !== undefined) {
    entries.push([keyword(app, "background"), options.background]);
  }
  if (options.onShapesReady !== undefined) {
    entries.push([keyword(app, "on-shapes-ready"), options.onShapesReady]);
  }
  call(
    app,
    KEY.initializeViewport,
    objects,
    zoom,
    vboxMap(app, vbox),
    arrayMap(app, entries),
  );
}

// set-rulers-visible! / set-rulers-frame-visible!: the workspace chrome of
// viewport-wasm.cljs. The rulers draw inside the canvas surface, so the
// caller turns them on after the viewport is initialized and asks for a
// render (the compiled effects do the same pair).
export function setWorkspaceRulersVisible(
  app: RendererApp,
  visible: boolean,
): void {
  call(app, KEY.setRulersFrameVisible, visible);
  call(app, KEY.setRulersVisible, visible);
  call(app, KEY.requestRender, "set-rulers-visible");
}

// The light palette of the reference workspace rulers
// (rulers-state/theme-colors): panel background, panel border, layer row
// foreground, accent tertiary.
const RULER_THEME = {
  bg: "#fff",
  border: "#eef0f2",
  label: "#495e74",
  accent: "#8c33eb",
} as const;

// hex->u32argb with opacity 1, the ARGB u32 the wasm ABI takes
// (sr-clr/hex->u32argb in the CLJS original). Expands the 3/4-digit
// shorthand so "#fff" reads 0xFFFFFFFF, not 0xFF000FFF.
function hexToArgbU32(hex: string): number {
  let value = hex.slice(1);
  if (value.length === 3 || value.length === 4) {
    value = [...value].map((c) => c + c).join("");
  }
  const argb = Number.parseInt(value, 16);
  return value.length === 6 ? (0xff << 24) | argb : argb;
}

// set-rulers-colors!: push the ruler chrome colors into the wasm UI state.
// The default RulerState is the dark theme, so the workspace must push the
// light palette once after the canvas init, like push-ruler-theme-colors!
// in viewport_wasm.cljs.
export function setWorkspaceRulerColors(app: RendererApp): void {
  const internal = app[KEY.internalModule] as Record<
    string,
    (...args: number[]) => unknown
  >;
  internal._set_rulers_colors(
    hexToArgbU32(RULER_THEME.bg),
    hexToArgbU32(RULER_THEME.border),
    hexToArgbU32(RULER_THEME.label),
    hexToArgbU32(RULER_THEME.accent),
  );
  call(app, KEY.requestRender, "set-rulers-colors");
}

// set-rulers-offsets!: the tick-label offset of the ruler scale, the
// viewport effect of rulers-state/display-state*. Selecting a single root
// frame shifts the scale to the frame origin; otherwise the selected
// shapes' shared parent frame origin applies. A null offset answers 0, like
// the compiled (:x selected-frame) on nil.
export function setWorkspaceRulersOffsets(
  app: RendererApp,
  offsetX: number,
  offsetY: number,
): void {
  call(app, KEY.setRulersOffsets, offsetX || 0, offsetY || 0);
}

// The selection rect of the ruler band: a CLJS PersistentArrayMap, since
// the compiled set-rulers-selection! reads :x/:y/:width/:height through
// the ILookup protocol (same shape rule as vboxMap). Null clears the band.
export interface RulerSelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function setWorkspaceRulersSelection(
  app: RendererApp,
  rect: RulerSelectionRect | null,
): void {
  if (rect === null) {
    call(app, KEY.setRulersSelection, null);
  } else {
    call(
      app,
      KEY.setRulersSelection,
      arrayMap(app, [
        [keyword(app, "x"), rect.x],
        [keyword(app, "y"), rect.y],
        [keyword(app, "width"), rect.width],
        [keyword(app, "height"), rect.height],
      ]),
    );
  }
  // The compiled viewport re-presents through render-from-backbuffer! here;
  // this port has no backbuffer surface, so the full render path stands in
  // (the same substitution as set-rulers-visible).
  call(app, KEY.requestRender, "set-rulers-selection");
}

// set-view-box: push zoom/vbox into the renderer. No-ops unless the context
// is ready (the guard lives inside the compiled function) and covers the
// whole interaction step, including the debounced finalize.
export function setWorkspaceViewBox(
  app: RendererApp,
  zoom: number,
  vbox: Point,
): void {
  call(app, KEY.setViewBox, zoom, vboxMap(app, vbox));
}

// clear-canvas with the default hard teardown (lose-browser-context? true):
// GPU resources released, GL context disposed. The unmount path of
// viewport-wasm.cljs.
export function clearWorkspaceCanvas(app: RendererApp): void {
  call(app, KEY.clearCanvas, arrayMap(app, []));
}
