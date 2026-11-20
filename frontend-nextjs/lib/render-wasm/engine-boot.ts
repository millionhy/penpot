// Boot of the TypeScript renderer for the app shell (G4.5b).
//
// The compiled frontend loads public/js/render-wasm.js through
// cf/resolve-href (public-uri + resource + ?version=<tag>) and lets the
// emscripten glue derive the .wasm URL. The engine's loadModule takes both
// URLs instead, so this module rebuilds the same pair:
//
//   <public-uri>/js/render-wasm.js?version=<tag>
//   <public-uri>/js/render-wasm.wasm?version=<tag>
//
// An empty public-uri means same origin: the shell serves public/js and the
// dev server has no /view rewrite for it, so the base stays root-relative
// ("/"), unlike the compiled app whose hash router always sits at "/".
//
// loadModule itself is idempotent (one instance per page, ~256 MB heap), so
// every caller may ask for the module freely.

import { config } from "@/lib/config";
import { loadModule, type RenderWasmModule } from "./engine";

function assetBase(): string {
  const publicUri = config.publicUri;
  if (publicUri === "") return "/";
  return publicUri.endsWith("/") ? publicUri : publicUri + "/";
}

function versionTag(): string {
  const version = config.version;
  return version !== null && version.length > 0 ? version : "develop";
}

// cf/resolve-href for one static artifact of public/js.
export function engineAssetUrl(file: string, version: string = versionTag()): string {
  return assetBase() + file + "?version=" + encodeURIComponent(version);
}

// The single wasm instance every engine call site shares.
export function loadEngineModule(): Promise<RenderWasmModule> {
  return loadModule({
    jsUrl: engineAssetUrl("js/render-wasm.js"),
    wasmUrl: engineAssetUrl("js/render-wasm.wasm"),
    printErr: (text: string) => console.error(text),
  });
}
