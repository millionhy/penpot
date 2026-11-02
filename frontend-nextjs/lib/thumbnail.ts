// Geometry of the dashboard thumbnail pass (F9.14). Pure functions only, so
// the numbers can be tested without a renderer or a worker.
//
// Ports of the pieces the reference worker composes
// (frontend/src/app/worker/thumbnails.cljs render-thumbnail-with-wasm):
// - THUMBNAIL_WIDTH / THUMBNAIL_ASPECT_RATIO: the 252px box and its 2:3
//   height (thumbnail-width in app.main.ui.dashboard.grid and
//   thumbnail-aspect-ratio in the worker).
// - fixAspectRatio: common geom/rect.cljc fix-aspect-ratio, which grows the
//   short side and re-centers instead of cropping.
// - normalizeRect: grc/update-rect :position (x1/y1 -> x2/y2 -> min/abs).
// - calculateDimensions: app.main.render/calculate-dimensions, the view box
//   used when the file has no frame marked use-for-thumbnail.

export const THUMBNAIL_WIDTH = 252;

// Height / width in the reference worker.
export const THUMBNAIL_ASPECT_RATIO = 2 / 3;

// app.main.render/max-export-dimension: the reference raises
// :export-area-too-large beyond this and the thumbnail pass fails.
export const MAX_EXPORT_DIMENSION = 100000;

export interface ThumbnailRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function thumbnailHeight(width: number = THUMBNAIL_WIDTH): number {
  return width * THUMBNAIL_ASPECT_RATIO;
}

// grc/update-rect :position: rebuild the rect from its corners, so a rect
// that grew left/up (negative width or height) reports a positive size at
// the top-left corner.
export function normalizeRect(rect: ThumbnailRect): ThumbnailRect {
  const x1 = rect.x;
  const y1 = rect.y;
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

// grc/fix-aspect-ratio: keep the rect center, expand the short side to the
// target ratio. Equality is a no-op, like the two strict cond-> branches.
export function fixAspectRatio(
  rect: ThumbnailRect,
  aspectRatio: number = THUMBNAIL_ASPECT_RATIO,
): ThumbnailRect {
  const targetHeight = rect.width * aspectRatio;
  if (targetHeight > rect.height) {
    return {
      ...rect,
      height: targetHeight,
      y: rect.y - (targetHeight - rect.height) / 2,
    };
  }
  if (targetHeight < rect.height) {
    const targetWidth = rect.height / aspectRatio;
    return {
      ...rect,
      width: targetWidth,
      x: rect.x - (targetWidth - rect.width) / 2,
    };
  }
  return rect;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

// grc/join-rects: one rect covering every input, or null when nothing
// contributes a finite corner (the reference answers nil for an empty seq).
export function joinRects(rects: readonly ThumbnailRect[]): ThumbnailRect | null {
  if (rects.length === 0) return null;
  let minx = Number.POSITIVE_INFINITY;
  let miny = Number.POSITIVE_INFINITY;
  let maxx = Number.NEGATIVE_INFINITY;
  let maxy = Number.NEGATIVE_INFINITY;
  for (const rect of rects) {
    minx = Math.min(minx, rect.x);
    miny = Math.min(miny, rect.y);
    maxx = Math.max(maxx, rect.x + rect.width);
    maxy = Math.max(maxy, rect.y + rect.height);
  }
  if (![minx, miny, maxx, maxy].every(Number.isFinite)) return null;
  return { x: minx, y: miny, width: maxx - minx, height: maxy - miny };
}

// render/calculate-dimensions: join the root-object bounds, repair the
// non-finite members the way the CLJS does (0 for the origin, 100000 for the
// size), reject an oversized export area, then normalize and fix the ratio.
// An empty page falls back to the arbitrary 100x100 rect.
export function calculateDimensions(
  bounds: readonly ThumbnailRect[],
  aspectRatio: number = THUMBNAIL_ASPECT_RATIO,
): ThumbnailRect {
  const joined = joinRects(bounds);
  if (joined === null) {
    return fixAspectRatio(normalizeRect({ x: 0, y: 0, width: 100, height: 100 }), aspectRatio);
  }

  const repaired: ThumbnailRect = {
    x: finiteOr(joined.x, 0),
    y: finiteOr(joined.y, 0),
    width: finiteOr(joined.width, MAX_EXPORT_DIMENSION),
    height: finiteOr(joined.height, MAX_EXPORT_DIMENSION),
  };
  if (
    repaired.width > MAX_EXPORT_DIMENSION ||
    repaired.height > MAX_EXPORT_DIMENSION ||
    repaired.x + repaired.width > MAX_EXPORT_DIMENSION ||
    repaired.y + repaired.height > MAX_EXPORT_DIMENSION
  ) {
    throw new Error("thumbnail: the page export area is too large");
  }
  return fixAspectRatio(normalizeRect(repaired), aspectRatio);
}