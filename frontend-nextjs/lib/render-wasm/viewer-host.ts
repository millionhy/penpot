// The viewer's host half of the shape upload (G4.5b, port of the CLJS
// set-object-host-attrs and its font/image store paths).
//
// The engine's `writeHostAttrs` covers the structure every runtime shares:
// svg-raw markup, grid tracks, text content and the image work. What it
// cannot know is where the pixels and the font files come from. This module
// answers both for the viewer:
//
// - images: `assets/by-file-media-id/<id>[/thumbnail][?share-id=]`, exactly
//   the cf/resolve-file-media URL the compiled viewer builds;
// - text fonts: the faces `getContentFonts` finds in a shape, resolved by
//   lib/render-wasm/fonts.ts against the bundle's custom variants, fetched
//   once per TTF URL and stored in the wasm font store.
//
// `settle` replays the tail of `process-pending` and `relayout-after-fonts!`:
// run the text layouts synchronously, wait for the thumbnail images and the
// font fetches (concurrently), wait for the full images (in order), then
// re-run the layout of the shapes whose faces were not in the store at upload
// time. Shapes whose faces were ready keep the layout the upload measured.
//
// Deviations from the CLJS original, documented:
// - Google-backed faces (including the emoji/Noto fallbacks) stay
//   unsupported, as documented in lib/render-wasm/fonts.ts: the catalog is
//   not part of the shell, so those runs fall back to the builtin face.
// - svg-raw shapes get no static markup: the shell has no SVG shape
//   renderer, so the viewer never draws them.
// - The stale-selrect model sync after a forced relayout belongs to the
//   editor; the viewer only needs the painted result, so it is not ported.
// - A face that failed once stays failed for the page, like the compiled
//   `failed-font-data-keys` set: later shapes fall back instead of retrying
//   the fetch on every pass.

import { config } from "@/lib/config";
import { resolveFileMedia } from "@/lib/viewer";
import type { DecodedBundle } from "./bundle";
import {
  fontIdToUuid,
  forceUpdateTextLayout,
  isFontUploaded,
  storeFont,
  storeFontUrl,
  updateTextLayout,
  writeHostAttrs,
  type ImageHost,
  type RenderWasmModule,
  type Shape,
} from "./engine";
import {
  closestVariant,
  getContentFonts,
  resolveFontFace,
  serializeFontWeight,
  type CustomVariant,
  type FontFaceRef,
} from "./fonts";

// The seam the viewer passes consume (viewer-render.ts, frame-render.ts).
export interface ViewerHost {
  // set-objects `onShape`: upload the host attrs of one prepared shape and
  // remember the pending image/font work.
  hostAttrs(shape: Shape): void;
  // Wait for the remembered work, then relayout the text shapes; resolves
  // once the pass may paint.
  settle(): Promise<void>;
}

export interface ViewerHostOptions {
  module: RenderWasmModule;
  // The decoded bundle: its `payload.fonts` maps a custom family uuid to the
  // variant rows, which carry the TTF file ids.
  bundle?: DecodedBundle | null;
  shareId?: string | null;
  // The origin the media and font URLs resolve against. Empty config
  // .publicUri means same origin, so the URLs become root-relative ("/").
  publicUri?: string;
  // Test seam: fetch the bytes of an image or a TTF.
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  onError?: (cause: unknown, resource: string) => void;
}

// One variant row of the bundle fonts map, normalized for closestVariant.
interface BundleVariant {
  readonly weight: string;
  readonly style: string;
  readonly ttfFileId?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rootUri(publicUri: string): string {
  return publicUri === "" ? "/" : publicUri;
}

// payload.fonts: `{ <family-uuid>: [variant, ...] }`. The rows keep the
// backend shape (`font-weight`, `font-style`, `ttf-file-id`), so the index
// normalizes both numbers and strings onto the closestVariant contract.
function indexBundleVariants(bundle: DecodedBundle | null | undefined): Map<string, BundleVariant[]> {
  const index = new Map<string, BundleVariant[]>();
  const fonts = bundle?.payload.fonts;
  if (!isObject(fonts)) return index;

  for (const [familyId, rows] of Object.entries(fonts)) {
    if (!Array.isArray(rows)) continue;
    const variants: BundleVariant[] = [];
    for (const row of rows) {
      if (!isObject(row)) continue;
      variants.push({
        weight: String(row["font-weight"] ?? ""),
        style: String(row["font-style"] ?? ""),
        ttfFileId: stringOf(row["ttf-file-id"]),
      });
    }
    if (variants.length > 0) index.set(familyId.toLowerCase(), variants);
  }
  return index;
}

function normalizeVariantId(value: string | undefined): string {
  return value === undefined ? "" : value.toLowerCase().replace(/\s+/g, "");
}

// The face key of the compiled `font-data-key`: the family uuid, the integer
// weight and style, and the emoji flag. The URL identifies a face too, but
// the key outlives one pass, so it uses the face fields.
function faceKey(id: string, weight: number, style: number, emoji: boolean): string {
  return `${id}|${weight}|${style}|${emoji ? 1 : 0}`;
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`the fetch answered ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

// The in-flight fetch of one TTF URL and the faces that already failed, per
// wasm module: both outlive a viewport run, like the compiled `fetching` and
// `failed-font-data-keys` atoms.
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

function failedFacesOf(module: RenderWasmModule): Set<string> {
  let set = failedFaces.get(module);
  if (set === undefined) {
    set = new Set();
    failedFaces.set(module, set);
  }
  return set;
}

export function createViewerHost(options: ViewerHostOptions): ViewerHost {
  const { module, bundle, shareId = null } = options;
  const publicUri = rootUri(options.publicUri ?? config.publicUri);
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const report = (cause: unknown, resource: string): void => {
    if (options.onError !== undefined) options.onError(cause, resource);
    else console.warn("[render-wasm] could not load a viewer resource:", resource, cause);
  };

  const variantIndex = indexBundleVariants(bundle);
  const inFlight = inFlightOf(module);
  const failed = failedFacesOf(module);

  const textIds: string[] = [];
  const thumbnails: Promise<void>[] = [];
  const full: Promise<void>[] = [];
  const fontWork: Promise<void>[] = [];
  const pendingShapeIds = new Set<string>();

  // The custom variant of one face reference: the family uuid selects the
  // rows, then the exact/nearest weight and style pick the TTF. A family the
  // bundle does not carry answers undefined and degrades like a missing file.
  const customVariantFor = (ref: FontFaceRef): CustomVariant | undefined => {
    const family = fontIdToUuid(ref.fontId);
    const variants = variantIndex.get(family.toLowerCase());
    if (variants === undefined || variants.length === 0) return undefined;

    const variantId = normalizeVariantId(ref.fontVariantId);
    const weight = serializeFontWeight(ref.fontWeight);
    const style = variantId.includes("italic") ? "italic" : (ref.fontStyle ?? "normal");
    const variant = closestVariant(variants, weight, style);
    if (variant === null) return undefined;

    return { weight: variant.weight, style: variant.style, ttfFileId: variant.ttfFileId };
  };

  // store-font-id: resolve, check the store, then fetch once per URL. A face
  // missing from the store at upload time marks its shape for the forced
  // relayout after the fetches settle, exactly like the pending-face keys of
  // the compiled pass.
  const requestFont = (shapeId: string, ref: FontFaceRef): void => {
    const outcome = resolveFontFace(ref, {
      publicUri,
      customVariant: customVariantFor(ref),
    });
    if (!outcome.ok) return; // google / missing custom asset / unknown: degrade

    const face = {
      id: outcome.face.familyUuid,
      weight: outcome.face.weight,
      style: outcome.face.style,
    };
    const emoji = outcome.face.isEmoji;
    const key = faceKey(face.id, face.weight, face.style, emoji);
    if (failed.has(key)) return;

    if (isFontUploaded(module, face, emoji)) {
      // The renderer draws from the store already; the URL is only metadata
      // (the SVG export reads it), which the compiled path registers too.
      storeFontUrl(module, face, outcome.face.ttfUrl);
      return;
    }

    pendingShapeIds.add(shapeId);

    const url = outcome.face.ttfUrl;
    let work = inFlight.get(url);
    if (work === undefined) {
      const created = fetchBytes(url)
        .then((bytes) => {
          if (!storeFont(module, face, bytes, { emoji, fallback: outcome.face.isFallback })) return;
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
    fontWork.push(work);
  };

  const images: ImageHost = {
    resolveUrl: (imageId, thumbnail) =>
      resolveFileMedia(publicUri, { id: imageId }, { thumbnail, shareId }),
    fetchBytes,
    onError: (cause, imageId) => report(cause, imageId),
  };

  const hostAttrs = (shape: Shape): void => {
    if (shape.type === "text") textIds.push(shape.id);

    const result = writeHostAttrs(module, shape, {
      text: {
        prepareFonts: (content) => {
          for (const ref of getContentFonts(content)) requestFont(shape.id, ref);
        },
        writeOptions: { normalizeFontId: (fontId) => fontIdToUuid(fontId) },
      },
      images,
      // The cold-load batch already carried the layout and the fills/strokes,
      // and only the grid tracks and the host data remain.
      skipLayout: true,
      skipFillsStrokes: true,
    });

    for (const item of result.thumbnails) thumbnails.push(item);
    for (const item of result.full) full.push(item);
  };

  const settle = async (): Promise<void> => {
    // process-pending: the layouts run synchronously so the shapes are
    // immediately correct, before any fetch completes.
    for (const id of textIds) updateTextLayout(module, id);

    if (thumbnails.length > 0 || fontWork.length > 0 || full.length > 0) {
      // Font fetches travel with the thumbnail images (concurrently); the
      // full variants follow in order. Every promise settles even on failure.
      await Promise.allSettled([...thumbnails, ...fontWork]);
      for (const item of full) {
        try {
          await item;
        } catch {
          // loadImage already reports; a rejection must not stop the pass.
        }
      }

      // relayout-after-fonts!: only the shapes that waited on a face need the
      // forced pass; everything else keeps the non-forced update.
      if (pendingShapeIds.size > 0) {
        for (const id of pendingShapeIds) forceUpdateTextLayout(module, id);
      } else {
        for (const id of textIds) updateTextLayout(module, id);
      }
    }
  };

  return { hostAttrs, settle };
}
