// calculate-size (F6.4): the viewer's padded frame bounds, the port of the
// private calculate-size in app.main.ui.viewer. The bounds come from the
// compiled bounds module instead of a TypeScript port:
//
//   (gsb/get-object-bounds objects frame {:ignore-margin? false})
//
// The padding depends on strokes (including open-path cap markers), shadows
// and blurs, and the compiled get_object_bounds already owns every rule
// (stroke-margin-multiplier, drop-shadow margin, blur doubling...), so the
// bridge calls the export and only multiplies by the zoom afterwards. The
// zoomed width/height size the canvas; x/y are the design-space top-left
// that feeds the wasm _set_view origin.

import { KEY, arrayMap, call, get, keyword, type RendererApp } from "./interop";

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
      `render-wasm: get-object-bounds ${label} is not a number ` +
        `(${JSON.stringify(value)}) — did the frame lookup fail?`,
    );
  }
  return value;
}

// (calculate-size objects frame zoom): the padded bounds, zoomed. The option
// map is the same one the CLJS passes (ignore-margin? false: the frame
// margin reserves room for its own strokes and shadows).
export function calculateSize(
  app: RendererApp,
  objects: unknown,
  frame: unknown,
  zoom: number,
): ViewerSize {
  const options = arrayMap(app, [[keyword(app, "ignore-margin?"), false]]);
  const bounds = call(app, KEY.getObjectBounds, objects, frame, options);
  const width = asNumber(get(app, bounds, keyword(app, "width")), "width");
  const height = asNumber(get(app, bounds, keyword(app, "height")), "height");
  const x = asNumber(get(app, bounds, keyword(app, "x")), "x");
  const y = asNumber(get(app, bounds, keyword(app, "y")), "y");
  return {
    baseWidth: width,
    baseHeight: height,
    x,
    y,
    width: width * zoom,
    height: height * zoom,
  };
}
