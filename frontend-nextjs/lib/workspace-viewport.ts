// Workspace viewport math (F9.1). Headless port of the zoom/view-box slice
// of app.main.data.workspace.viewport, app.main.data.workspace.zoom, the
// wheel handling of app.main.ui.workspace.viewport.actions and the
// normalizeWheel vendor (app.util.dom.normalize_wheel, the Facebook
// fixed-data-table version).
//
// Kept free of JSX so it runs in vitest's node environment; every function
// is pure and the view in components/workspace-wasm-canvas.tsx drives it.
//
// Deviations from the CLJS original, documented:
// - The store events (initialize-viewport, set-zoom,
//   update-viewport-position, update-viewport-size) become pure functions
//   over a plain {zoom, vbox, vport} state.
// - Vbox is kept as its four geometry fields; the x1/x2 corners the CLJS
//   record carries are recomputed by the consumers that need them.

import { immediateChildren, type WorkspaceObjects, type WorkspaceShape } from "@/lib/workspace";

export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ViewportPoint {
  x: number;
  y: number;
}

// The workspace-local slice this module owns: the world scale, the visible
// world box and the last viewport size.
export interface ViewportState {
  zoom: number;
  vbox: ViewportRect;
  vport: { width: number; height: number };
}

// set-zoom clamps to [0.01, 200].
export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 200;

// almost-zero? in app.common.math.
function isAlmostZero(value: number): boolean {
  return Math.abs(value) < 1e-4;
}

// make-rect: the width/height lower bound of 0.01.
function makeRect(x: number, y: number, width: number, height: number): ViewportRect {
  return { x, y, width: Math.max(width, 0.01), height: Math.max(height, 0.01) };
}

// --- Rect primitives (app.common.geom.rect) --------------------------------

// points->rect: the bounding rect of a points vector; nil when empty or
// non-numeric, like the d/num? guard.
export function pointsToRect(
  points: { x: number; y: number }[] | null | undefined,
): ViewportRect | null {
  if (points === null || points === undefined || points.length === 0) return null;
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const pt of points) {
    minx = Math.min(minx, pt.x);
    miny = Math.min(miny, pt.y);
    maxx = Math.max(maxx, pt.x);
    maxy = Math.max(maxy, pt.y);
  }
  if (
    !Number.isFinite(minx) ||
    !Number.isFinite(miny) ||
    !Number.isFinite(maxx) ||
    !Number.isFinite(maxy)
  ) {
    return null;
  }
  return makeRect(minx, miny, maxx - minx, maxy - miny);
}

// join-rects: the smallest rect containing all of them.
export function joinRects(rects: ViewportRect[]): ViewportRect | null {
  if (rects.length === 0) return null;
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const rect of rects) {
    minx = Math.min(minx, rect.x);
    miny = Math.min(miny, rect.y);
    maxx = Math.max(maxx, rect.x + rect.width);
    maxy = Math.max(maxy, rect.y + rect.height);
  }
  if (
    !Number.isFinite(minx) ||
    !Number.isFinite(miny) ||
    !Number.isFinite(maxx) ||
    !Number.isFinite(maxy)
  ) {
    return null;
  }
  return makeRect(minx, miny, maxx - minx, maxy - miny);
}

// shapes->rect in app.common.geom.shapes.common: the bounding rect of the
// shapes' :points (not their selrect).
export function shapesRect(shapes: WorkspaceShape[]): ViewportRect | null {
  const rects: ViewportRect[] = [];
  for (const shape of shapes) {
    const rect = pointsToRect(shape.points);
    if (rect !== null) rects.push(rect);
  }
  return joinRects(rects);
}

// rect->center.
export function rectCenter(rect: ViewportRect): ViewportPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

// transform-rect with scale-matrix(scale, center): every corner scales
// around the center point.
export function transformRect(
  rect: ViewportRect,
  scale: number,
  center: ViewportPoint,
): ViewportRect {
  const corners: ViewportPoint[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ].map((pt) => ({
    x: center.x + scale * (pt.x - center.x),
    y: center.y + scale * (pt.y - center.y),
  }));
  return pointsToRect(corners) ?? { ...rect };
}

// --- adjust-to-viewport (app.common.geom.align) ----------------------------

export interface AdjustToViewportOptions {
  padding?: number;
  minZoom?: number | null;
}

// adjust-to-viewport: the srect padded and reshaped to the viewport aspect
// ratio; when the resulting zoom would fall below minZoom, the srect
// top-left corner anchors a viewport/min-zoom box instead.
export function adjustToViewport(
  viewport: ViewportRect,
  srect: ViewportRect,
  options: AdjustToViewportOptions = {},
): ViewportRect {
  const padding = options.padding ?? 0;
  const minZoom = options.minZoom ?? null;
  const gprop = viewport.width / viewport.height;

  const padded: ViewportRect = {
    x: srect.x - padding,
    y: srect.y - padding,
    width: srect.width + padding + padding,
    height: srect.height + padding + padding,
  };

  const width = padded.width;
  const height = padded.height;
  const lprop = width / height;

  let adjusted: ViewportRect;
  if (gprop > lprop) {
    const width2 = (width / lprop) * gprop;
    const pad2 = (width2 - width) / 2;
    adjusted = { x: padded.x - pad2, y: padded.y, width: width2, height: padded.height };
  } else if (gprop < lprop) {
    const height2 = (height * lprop) / gprop;
    const pad2 = (height2 - height) / 2;
    adjusted = { x: padded.x, y: padded.y - pad2, width: padded.width, height: height2 };
  } else {
    adjusted = padded;
  }

  if (minZoom !== null && viewport.width / adjusted.width < minZoom) {
    const vboxWidth = viewport.width / minZoom;
    const vboxHeight = viewport.height / minZoom;
    return {
      x: srect.x - vboxWidth / 2,
      y: srect.y - vboxHeight / 2,
      width: vboxWidth,
      height: vboxHeight,
    };
  }
  return adjusted;
}

// --- Initial viewport (data/workspace/viewport initialize) -----------------

// initialize-viewport: fit the root children of the page. Content larger
// than the viewport scales down (padding 40, min zoom 0.01); content that
// fits centers on it at zoom 1. An empty page pins the world origin to the
// viewport corner, like the nil-srect branch of the CLJS.
export function initialViewport(vport: ViewportRect, objects: WorkspaceObjects): ViewportState {
  const shapes = immediateChildren(objects);
  const srect = shapesRect(shapes);

  if (srect === null) {
    return {
      zoom: 1,
      vport: { width: vport.width, height: vport.height },
      vbox: { x: 0, y: 0, width: vport.width, height: vport.height },
    };
  }

  if (srect.width > vport.width || srect.height > vport.height) {
    const adjusted = adjustToViewport(vport, srect, { padding: 40, minZoom: MIN_ZOOM });
    return {
      zoom: vport.width / adjusted.width,
      vport: { width: vport.width, height: vport.height },
      vbox: adjusted,
    };
  }

  const vx = srect.x + (srect.width - vport.width) / 2;
  const vy = srect.y + (srect.height - vport.height) / 2;
  return {
    zoom: 1,
    vport: { width: vport.width, height: vport.height },
    vbox: { x: vx, y: vy, width: vport.width, height: vport.height },
  };
}

// --- Zoom and scroll (data/workspace/zoom + viewport) ----------------------

// The clamp set-zoom applies to the zoom factor.
export function clampZoom(zoom: number): number {
  return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}

// set-zoom + impl-update-zoom: scale the world by `factor` around a pivot
// point in world coordinates (default: the box center), so the world point
// under the pivot stays put.
export function zoomBy(
  state: ViewportState,
  center: ViewportPoint | null,
  factor: number,
): ViewportState {
  const newZoom = clampZoom(state.zoom * factor);
  const scale = state.zoom / newZoom;
  const pivot = center ?? rectCenter(state.vbox);
  return {
    zoom: newZoom,
    vport: state.vport,
    vbox: transformRect(state.vbox, scale, pivot),
  };
}

// update-viewport-position: pan by a world-coordinate delta.
export function scrollBy(state: ViewportState, dx: number, dy: number): ViewportState {
  return {
    zoom: state.zoom,
    vport: state.vport,
    vbox: { ...state.vbox, x: state.vbox.x + dx, y: state.vbox.y + dy },
  };
}

export type ResizeType = "left" | "right" | "top" | "bottom" | "center";

// update-viewport-size: reshape the box for a new viewport size; the world
// scale is preserved (wprop/hprop are the size ratios). A resize to zero
// keeps the old state.
export function resizeViewport(
  state: ViewportState,
  size: { width: number; height: number },
  resizeType: ResizeType = "center",
): ViewportState {
  if (isAlmostZero(size.width) || isAlmostZero(size.height)) return state;

  const wprop = state.vport.width / size.width;
  const hprop = state.vport.height / size.height;
  const vbox = state.vbox;
  const width2 = vbox.width / wprop;
  const height2 = vbox.height / hprop;

  const x2 =
    resizeType === "left"
      ? vbox.x + (vbox.width - width2)
      : resizeType === "right"
        ? vbox.x
        : vbox.x + (vbox.width - width2) / 2;

  const y2 =
    resizeType === "top"
      ? vbox.y + (vbox.height - height2)
      : resizeType === "bottom"
        ? vbox.y
        : vbox.y + (vbox.height - height2) / 2;

  return {
    zoom: state.zoom,
    vport: { width: size.width, height: size.height },
    vbox: { x: x2, y: y2, width: width2, height: height2 },
  };
}

// --- Wheel (ui/workspace/viewport/actions + normalize_wheel) ---------------

// scale-per-pixel in actions.cljs.
export const SCALE_PER_PIXEL = -0.0057;

// on-mouse-wheel: the compound zoom factor of a wheel event; a positive
// (downward) delta zooms out.
export function wheelZoomFactor(deltaZoom: number): number {
  const scale = 1 + Math.abs(SCALE_PER_PIXEL * deltaZoom);
  return deltaZoom > 0 ? 1 / scale : scale;
}

// point->viewport in viewport-ref.cljs: client coordinates to world
// coordinates (the vbox system).
export function pointToViewport(
  point: ViewportPoint,
  bbox: ViewportPoint,
  zoom: number,
  vbox: ViewportRect,
): ViewportPoint {
  return {
    x: (point.x - bbox.x) / zoom + vbox.x,
    y: (point.y - bbox.y) / zoom + vbox.y,
  };
}

// schedule-scroll!: world-coordinate scroll deltas; on non-mac platforms
// shift remaps the vertical wheel to horizontal panning (macOS sends
// deltaX on its own).
export function wheelScrollDeltas(
  deltaX: number,
  deltaY: number,
  zoom: number,
  shift: boolean,
  macos: boolean,
): ViewportPoint {
  if (!macos && shift) return { x: deltaY / zoom, y: 0 };
  return { x: deltaX / zoom, y: deltaY / zoom };
}

export interface NormalizedWheel {
  spinX: number;
  spinY: number;
  pixelX: number;
  pixelY: number;
}

// The wheel fields the vendor reads; WheelEvent covers the standard ones.
export interface WheelLikeEvent {
  deltaX?: number;
  deltaY?: number;
  deltaMode?: number;
  detail?: number;
  wheelDelta?: number;
  wheelDeltaX?: number;
  wheelDeltaY?: number;
  axis?: number;
  HORIZONTAL_AXIS?: number;
}

const PIXEL_STEP = 10;
const LINE_HEIGHT = 40;
const PAGE_HEIGHT = 800;

// normalizeWheel: the wheel deltas in pixel units, whatever the browser
// reported (pixels, lines or pages).
export function normalizeWheel(event: WheelLikeEvent): NormalizedWheel {
  let sX = 0;
  let sY = 0;

  // Legacy fields
  if ("detail" in event) sY = event.detail ?? 0;
  if ("wheelDelta" in event) sY = -(event.wheelDelta ?? 0) / 120;
  if ("wheelDeltaY" in event) sY = -(event.wheelDeltaY ?? 0) / 120;
  if ("wheelDeltaX" in event) sX = -(event.wheelDeltaX ?? 0) / 120;

  // side scrolling on FF with DOMMouseScroll
  if ("axis" in event && event.axis === event.HORIZONTAL_AXIS) {
    sX = sY;
    sY = 0;
  }

  let pX = sX * PIXEL_STEP;
  let pY = sY * PIXEL_STEP;

  if ("deltaY" in event) pY = event.deltaY ?? 0;
  if ("deltaX" in event) pX = event.deltaX ?? 0;

  if ((pX || pY) && event.deltaMode) {
    if (event.deltaMode === 1) {
      // delta in LINE units
      pX *= LINE_HEIGHT;
      pY *= LINE_HEIGHT;
    } else {
      // delta in PAGE units
      pX *= PAGE_HEIGHT;
      pY *= PAGE_HEIGHT;
    }
  }

  // Fall-back if spin cannot be determined
  if (pX && !sX) sX = pX < 1 ? -1 : 1;
  if (pY && !sY) sY = pY < 1 ? -1 : 1;

  return { spinX: sX, spinY: sY, pixelX: pX, pixelY: pY };
}
