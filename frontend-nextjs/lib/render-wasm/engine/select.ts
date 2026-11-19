// The wasm cursor selection of app.common.render-wasm.api.select.
//
// Every setter in `props.ts` applies to the CURRENT shape, so the caller must
// select first. The guard is `live()`, not `ready()`: a context-restore
// reload may select shapes while `reloading?` still blocks application
// callers.

import { call } from "./call";
import { live, type RenderWasmModule } from "./module";
import { uuidToU32 } from "./uuid";

// use-shape: makes `id` current. No-op without a live context.
export function useShape(module: RenderWasmModule, id: string): boolean {
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