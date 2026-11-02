// Boot of the renderer's wasm module, split from bridge.ts because the
// dashboard thumbnail worker (lib/thumbnail.worker.ts) needs it without the
// page boot: bridge.boot() imports packages.ts and attaches container nodes
// to the document, neither of which exists in a worker. This file touches
// only $APP, so it runs in both scopes.
//
// app.render-wasm.api/module is a delay whose first deref starts the
// js/render-wasm.js + .wasm fetch, exactly what app.render-wasm/initialize
// does. Readiness is polled through the same predicate wasm/module-ready?
// uses, rebuilt here because it is private: internal_module with a callable
// _init.

import { call, KEY, sleep, type RendererApp } from "./interop";

export async function ensureWasmModule(app: RendererApp): Promise<"ready" | "booted"> {
  const moduleReady = (): boolean => {
    const internal = app[KEY.internalModule] as { _init?: unknown } | undefined;
    return internal !== undefined && typeof internal._init === "function";
  };
  if (moduleReady()) return "ready";

  const boot = call(app, KEY.deref, app[KEY.moduleDelay]);
  let bootFailed = false;
  if (
    boot !== null &&
    typeof boot === "object" &&
    typeof (boot as Promise<unknown>).then === "function"
  ) {
    (boot as Promise<unknown>).then(
      (ready) => {
        if (ready !== true) bootFailed = true;
      },
      () => {
        bootFailed = true;
      },
    );
  }

  const deadline = Date.now() + 30_000;
  while (!moduleReady()) {
    if (bootFailed) {
      throw new Error("wasm module boot failed (see the console for init_wasm_module output)");
    }
    if (Date.now() > deadline) {
      throw new Error("timed out after 30s waiting for the wasm module");
    }
    await sleep(100);
  }
  return "booted";
}