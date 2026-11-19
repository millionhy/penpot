// The wasm artifact lifecycle for the TypeScript renderer.
//
// Mirrors app.common.render-wasm.wasm plus the boot half of
// app.render-wasm.api: load public/js/render-wasm.js (the emscripten ESM
// glue) with `locateFile` pinned at the artifact URL, keep the one module
// instance every FFI call site shares, and gate the three readiness levels
// the compiled code uses:
//
//   moduleReady  the glue is instantiated and `_init` is callable
//   live         a GL context exists and is not marked lost
//   ready        live and not in the middle of a reload
//
// The instance is a module-level singleton on purpose: the artifact grows a
// 256 MB heap, so a second copy is not an option. `resetModule` exists for
// tests and for a future hard reload of the renderer.

import { EngineError } from "./errors";

// The exports the engine touches. Emscripten hands over its heap views and
// the runtime helpers on the module object; every `_name` export is a wasm
// function. The index signature keeps the long tail (and the shape setters
// the later slices call) reachable without a hand-written declaration for
// each of the 176 exports.
export interface RenderWasmModule {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAP32: Int32Array;
  HEAPF32: Float32Array;
  UTF8ToString: (ptr: number, maxBytes?: number, ignoreNull?: boolean) => string;
  _read_error_code?: () => number;
  [name: string]: unknown;
}

// The subset of the emscripten factory config the engine sets. The glue
// passes the requested file name (`render-wasm.wasm?version=<tag>`) and
// expects an absolute or root-relative URL back; the compiled frontend
// answered with a constant, and so does this loader.
export interface EmscriptenConfig {
  locateFile?: (file: string) => string;
  printErr?: (text: string) => void;
  [key: string]: unknown;
}

export type ModuleFactory = (
  config: EmscriptenConfig,
) => Promise<RenderWasmModule> | RenderWasmModule;

export interface LoadModuleOptions {
  // URL of the emscripten glue, e.g. "/js/render-wasm.js?version=develop".
  jsUrl: string;
  // URL of the wasm payload. The version query is part of the URL: the glue
  // asks for the file with a query of its own and the loader ignores it, so
  // any cache busting has to live here.
  wasmUrl: string;
  // Test seam: a factory for runtimes that cannot import a URL (node reads
  // the artifact from disk instead).
  factory?: ModuleFactory;
  // Routes the artifact's stderr. Emscripten prints wasm aborts here; the
  // compiled frontend left them on console.error.
  printErr?: (text: string) => void;
}

let instance: RenderWasmModule | undefined;
let pending: Promise<RenderWasmModule> | undefined;
let contextInitialized = false;
let contextLost = false;
let reloading = false;

// wasm/module-ready?. The predicate polls for a callable `_init`, which the
// glue installs once the wasm instance is wired up.
export function moduleReady(): boolean {
  return instance !== undefined && typeof instance._init === "function";
}

// Every FFI caller goes through this. Raising a named error here beats the
// TypeError on undefined that a missing module would otherwise produce in
// the middle of a render pass.
export function moduleOrThrow(): RenderWasmModule {
  if (instance === undefined) {
    throw new EngineError("wasm-module-not-ready", "render-wasm module is not initialized");
  }
  return instance;
}

export function setModule(next: RenderWasmModule | undefined): void {
  instance = next;
}

// Test/reload seam: drops the instance, any in-flight load and the context
// flags, so the next loadModule starts from a clean slate.
export function resetModule(): void {
  instance = undefined;
  pending = undefined;
  contextInitialized = false;
  contextLost = false;
  reloading = false;
}

async function defaultFactory(jsUrl: string): Promise<ModuleFactory> {
  // webpackIgnore keeps the bundler away from the specifier: the artifact is
  // a prebuilt file in public/js and must load as-is, exactly like the
  // compiled frontend's dynamic import. This path only runs in a browser or
  // worker; node callers inject a factory.
  const namespace = (await import(/* webpackIgnore: true */ jsUrl)) as {
    default?: ModuleFactory;
  };
  if (typeof namespace.default !== "function") {
    throw new EngineError(
      "wasm-module-not-ready",
      `render-wasm: ${jsUrl} did not export an emscripten factory`,
    );
  }
  return namespace.default;
}

async function instantiate(options: LoadModuleOptions): Promise<RenderWasmModule> {
  const factory = options.factory ?? (await defaultFactory(options.jsUrl));
  const config: EmscriptenConfig = { locateFile: () => options.wasmUrl };
  if (options.printErr !== undefined) config.printErr = options.printErr;

  const created = await factory(config);
  if (typeof created._init !== "function") {
    throw new EngineError(
      "wasm-module-not-ready",
      "render-wasm: the instantiated module has no _init export",
    );
  }
  setModule(created);
  return created;
}

// Idempotent, like the CLJS `delay` it replaces: the first caller starts the
// download + compile, concurrent callers join the same promise, and a failed
// load clears the cache so a retry can try again.
export function loadModule(options: LoadModuleOptions): Promise<RenderWasmModule> {
  if (instance !== undefined) return Promise.resolve(instance);

  pending ??= instantiate(options).catch((cause: unknown) => {
    pending = undefined;
    throw cause;
  });
  return pending;
}

// preload-module!: starts the download before the first viewport mounts.
// Errors are swallowed for the caller but a failed load is not cached, so a
// later call retries (and reports properly).
export function preloadModule(options: LoadModuleOptions): void {
  void loadModule(options).catch(() => undefined);
}

// --- Context state (app.common.render-wasm.wasm)

export function isContextInitialized(): boolean {
  return contextInitialized;
}

export function markContextInitialized(value = true): void {
  contextInitialized = value;
}

export function markContextLost(value = true): void {
  contextLost = value;
}

export function markReloading(value = true): void {
  reloading = value;
}

// live?: the GL/WASM pipeline exists and is not marked lost. True during a
// reload after re-init, which is why reload-internal renders use it.
export function live(): boolean {
  return contextInitialized && !contextLost;
}

// ready?: safe for normal application calls: live and not mid-reload.
export function ready(): boolean {
  return live() && !reloading;
}

// reset-context-state!: clears the canvas/GL bookkeeping without touching
// `contextLost` or `reloading`. During a context-restore reload `clear-canvas`
// runs while recovery is still in progress; clearing those flags here would
// reopen a window where callers think WebGL is ready before re-init finishes.
export function resetContextState(): void {
  contextInitialized = false;
}
