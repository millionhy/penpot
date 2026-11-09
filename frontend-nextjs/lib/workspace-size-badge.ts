// Selection size badge (D2): the "W x H" pill that follows a selection on
// the canvas. Port of selection-size-badge* in app.main.ui.measurements, the
// layer the CLJS viewport (viewport.cljs / viewport_wasm.cljs) draws under a
// selection. This module is the pure math; workspace-viewport-overlay turns
// the result into the <g> with the rect and the text.
//
// The badge box, the padding, the gap and the char width come straight from
// the CLJS constants (selection-badge-*); every size is in world units, so
// the caller divides by the zoom the same way the overlay divides a stroke.
//
// Deviations from the CLJS original, documented:
// - The badge stays axis-aligned and centered under the selection AABB. The
//   CLJS anchors a rotated single shape to its "most horizontal" bottom edge
//   (get-edge-for-badge) and rotates the pill to hug that edge; this slice
//   keeps the pill upright below the bounding box instead, which reads the
//   same for the unrotated case and is only a placement nuance for a rotated
//   one.
// - A single-line straight path uses endpoint controls rather than a size
//   badge in the CLJS; a path that thin already falls under the tiny-shape
//   hide rule here, so it renders no badge.

export interface SizeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SizeBadge {
  // The "W x H" label.
  text: string;
  // Badge center in world coordinates.
  cx: number;
  cy: number;
  // Badge box in world units (already scaled by the zoom).
  width: number;
  height: number;
  radius: number;
}

// The selection-badge-* constants of measurements.cljs, in screen pixels.
const BADGE_HEIGHT = 16;
const BADGE_PADDING_X = 6;
const BADGE_VERTICAL_GAP = 8;
const BADGE_BORDER_RADIUS = 2;
const BADGE_CHAR_WIDTH = 6.5;

// fmt/format-number with the default precision 2: round to two decimals and
// print without a trailing ".0" (mth/precision + dm/str).
export function formatSizeNumber(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

// The badge for a selection of intrinsic `width`/`height` sitting inside the
// world bounding box `bounds`, at `zoom`, clipped to `vbox`. Returns null when
// the shape is too small to fit the pill (the CLJS hidden? rule).
export function selectionSizeBadge(
  bounds: SizeBounds,
  width: number,
  height: number,
  zoom: number,
  vbox: SizeBounds,
): SizeBadge | null {
  if (!(zoom > 0)) return null;

  const badgeHeight = BADGE_HEIGHT / zoom;
  const paddingX = BADGE_PADDING_X / zoom;
  const gap = BADGE_VERTICAL_GAP / zoom;
  const radius = BADGE_BORDER_RADIUS / zoom;
  const charWidth = BADGE_CHAR_WIDTH / zoom;

  const text = `${formatSizeNumber(width)} x ${formatSizeNumber(height)}`;
  const badgeWidth = text.length * charWidth + 2 * paddingX;

  // A shape narrower than the pill, or shorter than its height, hides it.
  if (width < badgeWidth || height < badgeHeight) return null;

  const cx = bounds.x + bounds.width / 2;
  const belowCy = bounds.y + bounds.height + gap + badgeHeight / 2;
  const vboxBottom = vbox.y + vbox.height;
  // Below the selection when it still lands inside the viewport, otherwise
  // above it (the CLJS fits-above-vbox-bottom? flip).
  const cy =
    belowCy + badgeHeight / 2 <= vboxBottom
      ? belowCy
      : bounds.y - gap - badgeHeight / 2;

  return { text, cx, cy, width: badgeWidth, height: badgeHeight, radius };
}
