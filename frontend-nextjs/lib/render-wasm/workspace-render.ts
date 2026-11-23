// The workspace viewport's direct-to-canvas render layer (G4.6b).
//
// The port of the workspace branch of app.main.ui.workspace.viewport-wasm,
// now over the TypeScript engine instead of the compiled `$APP`. The calls
// keep the compiled order:
//
//   init-canvas-context
//   -> initialize-viewport (background, view, pool, set-objects)
//   -> rulers (theme, visibility, offsets, selection band)
//   -> set-view-box for every wheel/pan/resize step
//   -> clear-canvas on unmount
//
// The render loop owns the whole progressive pipeline: `set-view-box` enters
// the view interaction, blits the cached atlas and debounces the finalize;
// `set-objects` drives the loading state and the follow-up render.
//
// Deviations from the compiled original:
// - No page-transition lifecycle and no WebGL context-loss recovery: this
//   slice renders one page and the caller re-inits on a lost context. The
//   loop stays usable across a page switch (dispose resets its state).
// - The background always travels with opacity 1, like the compiled
//   workspace call.

import {
  clearCanvas,
  initCanvasContext,
  initializeViewport,
  resizeCanvas,
  setObjects,
  setRulersColors,
  setRulersFrameVisible,
  setRulersOffsets,
  setRulersSelection,
  setRulersVisible,
  type RulerRect,
  type ShapeObjects,
} from "@/lib/render-wasm/engine";
import type { WorkspaceApp } from "@/lib/render-wasm/workspace-app";

export interface Point {
  x: number;
  y: number;
}

// init-canvas-context: registers a WebGL2 context on the visible canvas,
// initializes the renderer and sizes the drawing buffer. False when the
// module is not booted or the context cannot be created; the caller retries,
// mirroring try-init in viewport-wasm.cljs.
export function initWorkspaceCanvas(
  app: WorkspaceApp,
  canvas: HTMLCanvasElement,
): boolean {
  return initCanvasContext(app.module, canvas) !== undefined;
}

// resize-canvas!: drawing buffer, render options and viewbox from the canvas
// CSS size.
export function resizeWorkspaceCanvas(
  app: WorkspaceApp,
  canvas: HTMLCanvasElement,
): void {
  resizeCanvas(app.module, canvas);
}

export interface WorkspaceViewportOptions {
  background?: string;
  onShapesReady?: () => void;
}

// initialize-viewport: canvas background, view, shapes pool and the shape
// load. The upload slice writes the host attrs (text, grids, fills) through
// the workspace host; the loop requests the render once the batch lands.
export function initializeWorkspaceViewport(
  app: WorkspaceApp,
  objects: ShapeObjects,
  zoom: number,
  vbox: Point,
  options: WorkspaceViewportOptions = {},
): void {
  const started = initializeViewport(app.module, objects, zoom, vbox, {
    background: options.background,
    backgroundOpacity: 1,
    stopProgressiveRender: () => app.loop.stopProgressiveRender(),
    setObjects: (pageObjects) => {
      void setObjects(app.module, pageObjects, {
        loop: app.loop,
        onShape: (shape) => app.host.hostAttrs(shape, { coldLoad: true }),
        onShapesReady: options.onShapesReady,
      });
    },
  });
  if (!started) {
    throw new Error("render-wasm: initialize-viewport refused (context not live)");
  }
}

// set-rulers-visible! / set-rulers-frame-visible!: the workspace chrome of
// viewport-wasm.cljs. The rulers draw inside the canvas surface, so the
// caller turns them on after the viewport is initialized and asks for a
// render (the compiled effects do the same pair).
export function setWorkspaceRulersVisible(
  app: WorkspaceApp,
  visible: boolean,
): void {
  setRulersFrameVisible(app.module, visible);
  setRulersVisible(app.module, visible);
  app.loop.requestRender("set-rulers-visible");
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

// set-rulers-colors!: push the ruler chrome colors into the wasm UI state.
// The default RulerState is the dark theme, so the workspace must push the
// light palette once after the canvas init, like push-ruler-theme-colors!
// in viewport_wasm.cljs.
export function setWorkspaceRulerColors(app: WorkspaceApp): void {
  setRulersColors(app.module, RULER_THEME);
  app.loop.requestRender("set-rulers-colors");
}

// set-rulers-offsets!: the tick-label offset of the ruler scale, the
// viewport effect of rulers-state/display-state*. Selecting a single root
// frame shifts the scale to the frame origin; otherwise the selected
// shapes' shared parent frame origin applies. A null offset answers 0, like
// the compiled (:x selected-frame) on nil.
export function setWorkspaceRulersOffsets(
  app: WorkspaceApp,
  offsetX: number,
  offsetY: number,
): void {
  setRulersOffsets(app.module, offsetX || 0, offsetY || 0);
}

export type RulerSelectionRect = RulerRect;

// set-rulers-selection!: the purple band of the ruler strip. The compiled
// viewport re-presents through render-from-backbuffer! here; this port has no
// backbuffer surface, so a full render path stands in (the same
// substitution as set-rulers-visible).
export function setWorkspaceRulersSelection(
  app: WorkspaceApp,
  rect: RulerSelectionRect | null,
): void {
  setRulersSelection(app.module, rect);
  app.loop.requestRender("set-rulers-selection");
}

// set-view-box: push zoom/vbox into the renderer. The loop owns the guard,
// the cache blit and the debounced finalize.
export function setWorkspaceViewBox(
  app: WorkspaceApp,
  zoom: number,
  vbox: Point,
): void {
  app.loop.setViewBox(zoom, vbox);
}

// clear-canvas with the default hard teardown (lose-browser-context? true):
// GPU resources released, GL context disposed. The loop drops its timers
// first, like the compiled stop-progressive-render! + clear-canvas pair.
export function clearWorkspaceCanvas(app: WorkspaceApp): void {
  app.loop.dispose();
  clearCanvas(app.module);
}
