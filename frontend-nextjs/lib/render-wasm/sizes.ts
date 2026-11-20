// calculate-size (F6.4): the viewer's padded frame bounds, the port of the
// private calculate-size in app.main.ui.viewer. Since G4.5b the bounds come
// from the TypeScript port of gsb/get-object-bounds rather than the compiled
// export:
//
//   (gsb/get-object-bounds objects frame {:ignore-margin? false})
//
// The padding depends on strokes (including open-path cap markers), shadows
// and blurs, and engine/bounds already owns every rule
// (stroke-margin-multiplier, drop-shadow margin, blur doubling...), so this
// module only multiplies by the zoom afterwards. The zoomed width/height size
// the canvas; x/y are the design-space top-left that feeds the wasm
// _set_view origin.

import { objectBounds } from "./engine";

// The shape of the CLJS calculate-size output the viewer passes around
// (base-* are zoom-free, width/height already carry the zoom).
export interface ViewerSize {
  baseWidth: number;
  baseHeight: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

function asNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `render-wasm: object-bounds ${label} is not a number ` +
        `(${JSON.stringify(value)}) — did the frame lookup fail?`,
    );
  }
  return value;
}

// (calculate-size objects frame zoom): the padded bounds, zoomed. The option
// map is the same one the CLJS passes (ignore-margin? false: the frame
// margin reserves room for its own strokes and shadows).
export function calculateSize(
  objects: Readonly<Record<string, unknown>>,
  frame: Record<string, unknown>,
  zoom: number,
): ViewerSize {
  const bounds = objectBounds(objects, frame, { ignoreMargin: false });
  const width = asNumber(bounds.width, "width");
  const height = asNumber(bounds.height, "height");
  const x = asNumber(bounds.x, "x");
  const y = asNumber(bounds.y, "y");
  return {
    baseWidth: width,
    baseHeight: height,
    x,
    y,
    width: width * zoom,
    height: height * zoom,
  };
}
