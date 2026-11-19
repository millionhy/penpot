// The TypeScript render-wasm engine.
//
// This is the replacement for the compiled `app.render-wasm.api` and the
// portable `app.common.render-wasm` layer that public/js/shared.js carries
// today. The slices land incrementally (G4): this barrel grows with each one
// so call sites import from "@/lib/render-wasm/engine" instead of reaching
// into the individual files.
//
// Provenance: the memory/call/enums trio is the same design the exporter
// ported under exporter/src-ts/app/wasm; the two ports are kept separate on
// purpose (each module builds and ships on its own), and this header is the
// place to record the overlap.

export { EngineError, type EngineErrorCode, type EngineErrorContext } from "./errors";
export {
  loadModule,
  preloadModule,
  resetModule,
  setModule,
  moduleOrThrow,
  moduleReady,
  isContextInitialized,
  markContextInitialized,
  markContextLost,
  markReloading,
  live,
  ready,
  resetContextState,
  type RenderWasmModule,
  type EmscriptenConfig,
  type ModuleFactory,
  type LoadModuleOptions,
} from "./module";
export { call } from "./call";
export {
  alloc,
  dataView,
  free,
  heapF32,
  heapI32,
  heapU8,
  heapU32,
  offset32,
  readString,
  sizeOf,
  slice,
  writeBuffer,
} from "./memory";
export {
  SERIALIZER_EXPORTS,
  SERIALIZERS,
  serializers,
  type EnumTable,
  type SerializerKey,
  type Serializers,
} from "./enums";
