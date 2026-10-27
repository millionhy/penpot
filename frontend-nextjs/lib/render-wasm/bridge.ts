// Loads the compiled ClojureScript renderer (public/js/shared.js, built by the
// repository frontend container) into the Next.js shell. This file is the
// equivalent of the boot contract in frontend/resources/templates/index.mustache
// plus libs.js: before the shared chunk evaluates, the host page must define a
// few globals the compiled code reads during module init.
//
// The globals, all consumed at shared.js evaluation time:
// - shadow$bridge(name): returns the module namespace for the name. The
//   compiled code reads `shadow$bridge("date-fns/format").default` and friends
//   once each, at module init. The registry is filled from
//   lib/render-wasm/packages.ts before the import below.
// - dynamicImport: a presence flag only (`typeof dynamicImport !==
//   "undefined"` gates the render-wasm module delay in api.cljs). No value is
//   read.
// - penpotVersion / penpotVersionTag / penpotBuildDate: app.config reads these
//   at load time; v/parse explodes on a nil version, so a dev-shaped value is
//   injected unless the page already set one.
//
// Nothing else is needed: shared.js carries its own copy of the closure
// library and defines its module-local dynamic-import helper (used for the
// wasm module fetch), so no shadow_esm_import global is required.

// The compiled frontend namespace object (see interop.ts) is re-exported
// here because every render-wasm caller imports it from this entry point.
import { call, KEY, sleep, type RendererApp } from "./interop";
export type { RendererApp };

let renderer: Promise<RendererApp> | null = null;

// Idempotent: the shared chunk caches at the module level and the registry is
// filled once, so every call after the first returns the same app object.
export function loadRenderer(): Promise<RendererApp> {
  renderer ??= boot();
  return renderer;
}

// SES repair quarantine. The bridged plugins-runtime (packages.ts) runs
// `repairIntrinsics` from SES at module scope. In the compiled frontend
// that repair lands before transit-js builds its handlers; in this shell
// both page chunks (app/layout.js and this route's page.js) have already
// evaluated transit-js, and its Handlers constructor branded the Uint8Array
// ctor with a non-configurable `transit$guid$*` property
// (com.cognitect.transit.handlers.typeTag). SES's
// removeUnpermittedIntrinsics then cannot delete that property and aborts
// the boot with "Cannot delete property 'transit$guid$...' of function
// Uint8Array()". The compiled renderer never touches SES (no repair/harden
// references in shared.js or main.js), so `globalThis.repairIntrinsics` is
// held at a no-op: the lockdown shim's own assignment is swallowed by the
// setter, and plugins-runtime's bare `repairIntrinsics({...})` call resolves
// through the getter to the no-op.
// TODO(plugin sandbox slice): run the repair in an isolated realm, or before
// any transit-js evaluation, once the shell grows real plugin support.
function quarantineSesRepair(): void {
  const noop = (): void => {
    console.warn(
      "[render-wasm] repairIntrinsics suppressed: the SES repair cannot " +
        "run in this shell yet (see bridge.ts)",
    );
  };
  Object.defineProperty(globalThis, "repairIntrinsics", {
    configurable: true,
    get: () => noop,
    set: () => {
      // Swallow the SES lockdown shim's assignment; the global keeps
      // resolving to the no-op above.
    },
  });
}

// app.main evaluates `mf/create-root (dom/get-element "app")` from its
// module body (main.cljs defonce app-root), and index.mustache ships the
// containers div#app and section#modal for it. The shell pages have no
// such nodes, so empty hidden stand-ins are attached to <body> before the
// chunk graph evaluates.
function ensureHostContainers(): void {
  const containers: ReadonlyArray<readonly [string, string]> = [
    ["app", "div"],
    ["modal", "section"],
  ];
  for (const [id, tag] of containers) {
    if (document.getElementById(id) === null) {
      const el = document.createElement(tag);
      el.id = id;
      el.style.display = "none";
      document.body.appendChild(el);
    }
  }
}

async function boot(): Promise<RendererApp> {
  if (typeof window === "undefined") {
    throw new Error("render-wasm: loadRenderer is browser-only");
  }

  quarantineSesRepair();
  ensureHostContainers();
  const { bridgedModules } = await import("./packages");

  const registry = new Map<string, unknown>(Object.entries(bridgedModules));
  const bridge = (name: string, value?: unknown): unknown => {
    if (value !== undefined) {
      registry.set(name, value);
      return value;
    }
    const mod = registry.get(name);
    if (mod === undefined) {
      throw new Error(`render-wasm: no bridged module for "${name}"`);
    }
    return mod;
  };

  const globals = globalThis as Record<string, unknown>;
  globals["shadow$bridge"] = bridge;
  globals["dynamicImport"] = true;
  globals["penpotVersion"] ??= "develop";
  globals["penpotVersionTag"] ??= "develop";
  globals["penpotBuildDate"] ??= "unknown";
  // The workspace chrome mirrors the CLJS UI, which does not carry the
  // renderer's "WebGL rendering" label (the compiled default flags enable
  // :render-wasm-info; disable- removes it).
  globals["penpotFlags"] ??= "disable-render-wasm-info";

  // webpackIgnore keeps webpack away from the specifiers: both files are
  // prebuilt artifacts in public/js and must load as-is, like they do in the
  // frontend container. The import() runs in the browser only (boot() is
  // guarded), exactly the environment the artifacts were compiled for.
  //
  // Load main.js (the app.main entry chunk) first: evaluating it registers
  // the transit read handlers that live with app.main-reachable namespaces
  // (penpot/objects-map/v2 and friends) and runs its shadow$bridge calls
  // (@penpot/plugins-runtime, react-error-boundary). shared.js alone — the
  // :shared chunk — leaves the handler registry incomplete. main.js imports
  // ./shared.js itself, so the chunk graph shares one module instance.
  const mainUrl = "/js/main.js";
  await import(/* webpackIgnore: true */ mainUrl);

  const sharedUrl = "/js/shared.js";
  const shared = (await import(/* webpackIgnore: true */ sharedUrl)) as {
    $APP?: RendererApp;
  };

  const app = shared.$APP;
  if (app === undefined) {
    throw new Error("render-wasm: shared.js did not export $APP");
  }
  return app;
}

// Boot the wasm module. app.render-wasm.api/module is a delay whose first
// deref starts the js/render-wasm.js + .wasm fetch, exactly what
// app.render-wasm/initialize does. Readiness is polled through the same
// predicate wasm/module-ready? uses, rebuilt here because it is private:
// internal_module with a callable _init.
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
