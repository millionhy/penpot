// The workspace runtime handle (G4.6b).
//
// The workspace canvas used to hold the compiled `$APP` object: every
// drawing, upload and modifier call went through it. This module replaces
// that object with one small handle that owns the shared engine module and
// the render loop, plus the host half of the shape upload.
//
// The host is the workspace twin of `viewer-host.ts`: `writeHostAttrs`
// covers the structure every runtime shares (text content, grid tracks,
// fills and strokes), while this module answers where the resources come
// from. The workspace differs from the viewer in three ways:
//
// - it renders incrementally, so a shape upload may be a cold batch record
//   (layout and fills already written) or one incremental `set_object`
//   (layout and fills still pending), hence the `coldLoad` switch;
// - it has no decoded bundle, so custom font variants degrade like a
//   missing asset and google faces stay on the builtin fallback, matching
//   the scope `lib/render-wasm/fonts.ts` documents;
// - image pixels arrive through the explicit hydration pass and the image
//   tool, not through a per-shape URL fetch, because an uploaded fill may
//   carry a data URI.
//
// A font fetch that lands after the upload forces the layout of the shapes
// that waited on it, the job the pre-engine hydration pass did. Fetches are
// deduplicated per URL and failed faces stay failed for the module, like the
// compiled `fetching` and `failed-font-data-keys` atoms.

import { config } from "@/lib/config";
import {
  getContentFonts,
  resolveFontFace,
  type CustomVariant,
  type FontFaceRef,
} from "@/lib/render-wasm/fonts";
import {
  RenderLoop,
  forceUpdateTextLayout,
  fontIdToUuid,
  isFontUploaded,
  live,
  ready,
  storeFont,
  storeFontUrl,
  writeHostAttrs,
  type RenderWasmModule,
  type Shape,
} from "@/lib/render-wasm/engine";

export interface WorkspaceApp {
  readonly module: RenderWasmModule;
  readonly loop: RenderLoop;
  readonly host: WorkspaceHost;
}

export interface WorkspaceHost {
  // `set-objects` / `set-object` `onShape`: write the host attrs of one
  // shape. `coldLoad` marks a shape whose batch record already carried the
  // layout and the fill/stroke lists.
  hostAttrs(shape: Shape, options?: { coldLoad?: boolean }): void;
}

export interface WorkspaceHostOptions {
  module: RenderWasmModule;
  // The origin media and font URLs resolve against; default config.publicUri.
  publicUri?: string;
  // Injected for the tests; default is fetch + arrayBuffer.
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  // The team registry row of a custom face. The workspace does not track the
  // registry yet, so the default leaves custom faces on the fallback.
  getCustomVariant?: (ref: FontFaceRef) => CustomVariant | undefined;
  // Called after a pending face lands and its waiting text shapes are
  // re-laid out. The workspace asks the render loop for one frame, like the
  // compiled `process-pending` does after `relayout-after-fonts!`.
  onFontsReady?: () => void;
  onError?: (cause: unknown, resource: string) => void;
}

export interface WorkspaceAppOptions extends Omit<WorkspaceHostOptions, "module"> {
  // `view-gesture-active?` of the compiled renderer: a pointer pan keeps the
  // view interaction open across the render-finish debounce.
  isGestureActive?: () => boolean;
}

function rootUri(publicUri: string): string {
  return publicUri === "" ? "/" : publicUri;
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`the font fetch answered ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

// One face key: the family uuid, weight, style and emoji flag, the fields
// `_is_font_uploaded` reads.
function faceKeyOf(id: string, weight: number, style: number, emoji: boolean): string {
  return `${id}|${weight}|${style}|${emoji ? 1 : 0}`;
}

// Cross-mount caches: a StrictMode replay or a page switch must not refetch
// a face the renderer already holds or one that already failed.
const inFlightFonts = new WeakMap<RenderWasmModule, Map<string, Promise<void>>>();
const failedFaces = new WeakMap<RenderWasmModule, Set<string>>();

function inFlightOf(module: RenderWasmModule): Map<string, Promise<void>> {
  let map = inFlightFonts.get(module);
  if (map === undefined) {
    map = new Map();
    inFlightFonts.set(module, map);
  }
  return map;
}

function failedOf(module: RenderWasmModule): Set<string> {
  let set = failedFaces.get(module);
  if (set === undefined) {
    set = new Set();
    failedFaces.set(module, set);
  }
  return set;
}

export function createWorkspaceHost(options: WorkspaceHostOptions): WorkspaceHost {
  const { module } = options;
  const publicUri = rootUri(options.publicUri ?? config.publicUri);
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const report = (cause: unknown, resource: string): void => {
    if (options.onError !== undefined) options.onError(cause, resource);
    else console.warn("[workspace] could not load a renderer resource:", resource, cause);
  };

  const inFlight = inFlightOf(module);
  const failed = failedOf(module);
  // The shapes waiting on each face, force-relaid out once it lands.
  const waiting = new Map<string, Set<string>>();

  const requestFont = (shapeId: string, ref: FontFaceRef): void => {
    const outcome = resolveFontFace(ref, {
      publicUri,
      customVariant: options.getCustomVariant?.(ref),
    });
    if (!outcome.ok) return; // google / missing custom asset / unknown: degrade

    const face = {
      id: outcome.face.familyUuid,
      weight: outcome.face.weight,
      style: outcome.face.style,
    };
    const emoji = outcome.face.isEmoji;
    const key = faceKeyOf(face.id, face.weight, face.style, emoji);
    if (failed.has(key)) return;

    if (isFontUploaded(module, face, emoji)) {
      // The faces are already in the store; only the source URL for the SVG
      // export is missing.
      storeFontUrl(module, face, outcome.face.ttfUrl);
      return;
    }

    let ids = waiting.get(key);
    if (ids === undefined) {
      ids = new Set();
      waiting.set(key, ids);
    }
    ids.add(shapeId);

    const url = outcome.face.ttfUrl;
    let work = inFlight.get(url);
    if (work === undefined) {
      const created = fetchBytes(url)
        .then((bytes) => {
          if (!storeFont(module, face, bytes, { emoji, fallback: outcome.face.isFallback })) {
            return;
          }
          storeFontUrl(module, face, url);
          failed.delete(key);
        })
        .catch((cause: unknown) => {
          failed.add(key);
          report(cause, url);
        });
      inFlight.set(url, created);
      void created.finally(() => {
        if (inFlight.get(url) === created) inFlight.delete(url);
      });
      work = created;
    }

    void work.then(() => {
      const ids2 = waiting.get(key);
      if (ids2 === undefined || !isFontUploaded(module, face, emoji)) return;
      waiting.delete(key);
      for (const id of ids2) forceUpdateTextLayout(module, id);
      options.onFontsReady?.();
    });
  };

  const hostAttrs = (shape: Shape, attrs: { coldLoad?: boolean } = {}): void => {
    if (!live()) return;
    const coldLoad = attrs.coldLoad === true;
    writeHostAttrs(module, shape, {
      text: {
        prepareFonts: (content) => {
          for (const ref of getContentFonts(content)) requestFont(shape.id, ref);
        },
        writeOptions: { normalizeFontId: (fontId) => fontIdToUuid(fontId) },
      },
      // The batch record carried the layout and the fill/stroke lists.
      skipLayout: coldLoad,
      skipFillsStrokes: coldLoad,
    });
  };

  return { hostAttrs };
}

// The single workspace handle of a canvas: the shared module, one render
// loop and the host bridge.
export function createWorkspaceApp(
  module: RenderWasmModule,
  options: WorkspaceAppOptions = {},
): WorkspaceApp {
  const loop = new RenderLoop({
    module: () => module,
    live,
    ready,
    isGestureActive: options.isGestureActive,
    onError: (cause) => {
      if (options.onError !== undefined) options.onError(cause, "render");
      else console.error("[render-wasm] render failed:", cause);
    },
  });
  const host = createWorkspaceHost({
    ...options,
    module,
    onFontsReady: () => {
      options.onFontsReady?.();
      loop.requestRender("fonts-loaded");
    },
  });
  return { module, loop, host };
}
