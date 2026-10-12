// The open-overlay list of the wasm viewer (F6.5): the state half of the
// overlay events in app.main.data.viewer. The list holds one entry per open
// overlay frame, in open order; the viewer renders one container per entry
// in the same order (the later entries stack above).
//
// The guards mirror the CLJS events: open-overlay ignores a frame that is
// already open; toggle-overlay closes an open frame and opens a closed one;
// close-overlay removes by frame id.
//
// Deviations from the CLJS original, documented:
// - close-overlay with an animation does not defer the removal here: the
//   animation slice (f65f) will hold the entry until the WAAPI rewind
//   finishes; this module always answers the immediate list.
// - The toggle close passes the inverted animation in the CLJS (the close
//   animation rewind); inversion stays with the caller when the animation
//   slice wires it.
//
// Kept free of JSX so it runs in vitest's node environment, like
// lib/viewer-interactions.ts.
//
// A no-op returns the same list reference, so the React state setter can
// skip the re-render (the CLJS reducers always rebuild, the store diffs).

import type { OverlaySpec } from "./viewer-interactions";

// dv/open-overlay: (if-not (some #(= (:frame %) frame) overlays) conj).
export function openOverlay(overlays: OverlaySpec[], overlay: OverlaySpec): OverlaySpec[] {
  if (overlays.some((o) => o.frameId === overlay.frameId)) return overlays;
  return [...overlays, overlay];
}

// dv/toggle-overlay: an open frame closes, a closed one opens.
export function toggleOverlay(overlays: OverlaySpec[], overlay: OverlaySpec): OverlaySpec[] {
  if (overlays.some((o) => o.frameId === overlay.frameId)) {
    return overlays.filter((o) => o.frameId !== overlay.frameId);
  }
  return [...overlays, overlay];
}

// dv/close-overlay: (d/removev #(= (:id (:frame %)) frame-id) overlays).
export function closeOverlay(overlays: OverlaySpec[], frameId: string): OverlaySpec[] {
  const next = overlays.filter((o) => o.frameId !== frameId);
  return next.length === overlays.length ? overlays : next;
}
