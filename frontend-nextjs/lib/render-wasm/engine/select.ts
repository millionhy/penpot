// The wasm cursor selection of app.common.render-wasm.api.select.
//
// Every setter in `props.ts` applies to the CURRENT shape, so the caller must
// select first. The guard is `live()`, not `ready()`: a context-restore
// reload may select shapes while `reloading?` still blocks application
// callers.

import { call } from "./call";
import { live, ready, type RenderWasmModule } from "./module";
import { uuidToU32 } from "./uuid";

// use-shape: makes `id` current. No-op without a live context. Named
// `selectShape` because the React hooks rule reads `useShape` as a hook.
export function selectShape(module: RenderWasmModule, id: string): boolean {
  if (!live()) return false;
  const words = uuidToU32(id);
  call(module, "_use_shape", words[0], words[1], words[2], words[3]);
  return true;
}

// has-shape: the renderer answers 1 for a known id.
export function hasShape(module: RenderWasmModule, id: string): boolean {
  if (!live()) return false;
  const words = uuidToU32(id);
  return call<number>(module, "_has_shape", words[0], words[1], words[2], words[3]) === 1;
}

// intersect-position-in-shape: whether the point falls inside the rendered
// shape. The compiled wrapper is only meaningful for text, where the glyphs
// answer instead of the selrect. The application-driven guard is `ready()`,
// like the compiled `initialized?` check before the internal call.
export function intersectPositionInShape(
  module: RenderWasmModule,
  id: string,
  x: number,
  y: number,
): boolean {
  if (!ready()) return false;
  const words = uuidToU32(id);
  return (
    call<number>(
      module,
      "_intersect_position_in_shape",
      words[0],
      words[1],
      words[2],
      words[3],
      x,
      y,
    ) === 1
  );
}
