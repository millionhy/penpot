// The dashboard thumbnail worker (F9.14): the off-thread half of the
// reference's :worker build (frontend/src/app/worker/thumbnails.cljs,
// render-thumbnail-with-wasm).
//
// The worker boots the prebuilt renderer (public/js/shared.js + the wasm
// module) itself. shared.js evaluates without a document as long as the
// globals below exist, but main.js does not (its module body creates a React
// root), so the transit read handler that lives there (penpot/objects-map/v2)
// is registered here instead; see lib/thumbnail-render.ts.
//
// The worker must be served from an http URL, not a blob URL: the renderer
// fetches js/render-wasm.wasm through a relative path and a blob worker has
// no base URL to resolve it against. new Worker(new URL("./thumbnail.worker.ts",
// import.meta.url)) gives exactly that.

import { ensureWasmModule } from "@/lib/render-wasm/module";
import type { RendererApp } from "@/lib/render-wasm/interop";
import { registerObjectsMapHandler, renderThumbnailFromRaw } from "@/lib/thumbnail-render";
import { THUMBNAIL_WIDTH } from "@/lib/thumbnail";

interface RenderRequest {
  id: number;
  // The undecoded get-file-data-for-thumbnail answer (cmdRaw), decoded here
  // with the compiled transit read handlers.
  raw: string;
  width?: number;
  // Same-origin base the renderer resolves js/render-wasm.js against; the
  // cf/public-uri of the page. Empty means location.origin.
  publicUri?: string;
}

interface RenderResponse {
  id: number;
  blob?: Blob;
  error?: string;
}

// A structural cast instead of DedicatedWorkerGlobalScope: the project's
// tsconfig also loads the DOM lib, whose `self`/postMessage would conflict.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<RenderRequest>) => void) | null;
  postMessage: (message: RenderResponse) => void;
  location: { origin: string };
};

// The globals shared.js reads while it evaluates, the same set
// lib/render-wasm/bridge.ts installs on the page. shadow$bridge may answer a
// permissive proxy for every module: the worker never drives the UI code
// that would use the real implementations.
function installGlobals(publicUri?: string): void {
  const globals = globalThis as unknown as Record<string, unknown>;
  // The annotation breaks the self-referential inference cycle (TS7022):
  // the proxy hands itself back from get/apply/construct.
  const any: unknown = new Proxy(function () {}, {
    get: (_target, key) => {
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "toString" || key === "valueOf") return () => "";
      if (key === "then") return undefined;
      return any;
    },
    apply: () => any,
    // construct must answer an object, and the proxy answers itself.
    construct: () => any as object,
  });
  globals["shadow$bridge"] = () => any;
  globals["dynamicImport"] = true;
  globals["penpotVersion"] ??= "develop";
  globals["penpotVersionTag"] ??= "develop";
  globals["penpotBuildDate"] ??= "unknown";
  globals["penpotFlags"] ??= "disable-render-wasm-info";
  // Workers have no animation frames; the renderer only uses them to
  // schedule, so a timer is enough.
  globals["requestAnimationFrame"] ??= (callback: (time: number) => void) =>
    setTimeout(() => callback(performance.now()), 16);
  globals["cancelAnimationFrame"] ??= (handle: number) => clearTimeout(handle);
  // Always resolve the public URI so the CLJS config (cf/public-uri)
  // builds valid absolute media URLs for fetch-image inside the worker.
  // The fallback is location.origin (the worker's own origin).
  const base = (typeof publicUri === "string" && publicUri.length > 0)
    ? publicUri
    : scope.location.origin;
  globals["penpotPublicURI"] = base;
}

async function boot(publicUri?: string): Promise<RendererApp> {
  installGlobals(publicUri);
  // webpackIgnore keeps the bundler away from the specifier: shared.js is a
  // prebuilt artifact in public/js and must load as-is.
  const shared = (await import(/* webpackIgnore: true */ scope.location.origin + "/js/shared.js")) as {
    $APP?: RendererApp;
  };
  const app = shared.$APP;
  if (app === undefined) throw new Error("thumbnail: shared.js did not export $APP");
  registerObjectsMapHandler(app);
  await ensureWasmModule(app);
  return app;
}

// One boot per worker; a failed boot stays failed so the card pass does not
// retry the whole wasm fetch for every file.
let appPromise: Promise<RendererApp> | null = null;

// The reference serializes with an rx subject + mapcat; the worker needs the
// same because one wasm context cannot run two passes at once.
let queue: Promise<void> = Promise.resolve();

async function handle(request: RenderRequest): Promise<void> {
  try {
    appPromise ??= boot(request.publicUri);
    const app = await appPromise;
    const blob = await renderThumbnailFromRaw(
      app,
      request.raw,
      request.width ?? THUMBNAIL_WIDTH,
    );
    scope.postMessage({ id: request.id, blob });
  } catch (cause) {
    scope.postMessage({
      id: request.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

scope.onmessage = (event: MessageEvent<RenderRequest>): void => {
  const request = event.data;
  queue = queue.then(
    () => handle(request),
    () => handle(request),
  );
};