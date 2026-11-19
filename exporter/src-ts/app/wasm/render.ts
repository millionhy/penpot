// app.wasm.render: the headless scene pipeline.
//
// Per request: fetch the scene (get-page RPC) -> serialize it -> provision
// fonts and images -> relayout text with the real fonts -> render each object.
// Runs inside a render worker (`app.wasm.worker`), one wasm design state per
// worker, so the synchronous Skia calls never block the process that serves
// http. `app.renderer.wasm` is the main-thread side that drives it.
//
// Mirrors `exporter/src/app/wasm/render.cljs`. The fetch, temp file and write
// steps are injectable so tests exercise the pipeline without a backend, a
// worker, or disk access.

import { writeFileSync } from "node:fs";
import { get, getInternalUri, managementKey } from "../config.js";
import { AppError, raise } from "../errors.js";
import {
  addEmojiFont,
  addNotoFonts,
  collectUsedLanguages,
  containsEmoji,
  gfontIdToUuid,
  gstaticToProxyUrl,
  resolveTtfFile,
  resolveTtfUrl,
  type FallbackFont,
} from "../fonts.js";
import { sceneImageIds } from "../images.js";
import { createLogger, setLevel } from "../logging.js";
import type { RenderObject, RenderParams } from "../renderer.js";
import * as transit from "../transit.js";
import { ensurePathSlash, join } from "../uri.js";
import { getExtension, type ExportType } from "../util/mime.js";
import { tempfile } from "../util/shell.js";
import * as uuid from "../uuid.js";
import * as wasm from "../wasm.js";
import type { FontFamily, WasmModule } from "../wasm.js";
import { translateRasterFormat } from "./serializers.js";
import { serializeScene } from "./serialize.js";
import type { Shape } from "./upload.js";

const log = createLogger("app.wasm.render");
setLevel("app.wasm.render", "debug");

export interface HeadlessParams extends RenderParams {
  "cancelled?"?: () => boolean;
}

// --- injectable transport and output

export interface FetchResponseLike {
  status: number;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FetchInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

export type FetchFn = (uri: string, init: FetchInit) => Promise<FetchResponseLike>;

export interface RenderDeps {
  fetch: FetchFn;
  tempfile(options: { prefix?: string; suffix?: string }): string;
  writeFile(path: string, bytes: Uint8Array): void;
}

const defaultDeps: RenderDeps = {
  fetch: (uri, init) =>
    fetch(uri, init as unknown as RequestInit) as unknown as Promise<FetchResponseLike>,
  tempfile,
  writeFile: (filePath, bytes) => writeFileSync(filePath, bytes),
};

let deps: RenderDeps = defaultDeps;

export function setDeps(next?: Partial<RenderDeps>): void {
  deps = { ...defaultDeps, ...next };
}

// --- module lifecycle (one shared, lazily-initialized instance)

export type ModuleLoader = () => Promise<WasmModule>;

let moduleLoader: ModuleLoader = wasm.init;
let modulePromise: Promise<WasmModule> | undefined;

export function setModuleLoader(next?: ModuleLoader): void {
  moduleLoader = next ?? wasm.init;
  modulePromise = undefined;
}

async function ensureModule(): Promise<WasmModule> {
  if (modulePromise === undefined) modulePromise = moduleLoader();

  try {
    return await modulePromise;
  } catch (cause) {
    modulePromise = undefined;
    throw cause;
  }
}

// --- backend endpoints
//
// Every fetch targets the internal endpoint (falling back to public-uri), which
// is how the exporter reaches the backend over the container network.

function internalUri(path: string): string {
  return join(ensurePathSlash(getInternalUri()), path).toString();
}

// Whoever opens an exported SVG resolves its @font-face sources, so those
// cannot use the internal endpoint.
function publicUri(path: string): string {
  return join(ensurePathSlash(get("public-uri")), path).toString();
}

function rpcHeaders(token: string | undefined): Record<string, string> {
  return {
    "Content-Type": "application/transit+json",
    "X-Shared-Key": `exporter ${managementKey()}`,
    Authorization: `Bearer ${token ?? ""}`,
  };
}

// Cookie, not Bearer: /assets/* redirects to a presigned S3/minio url, and a
// Bearer header makes S3 reject the request with a 400.
function assetHeaders(token: string | undefined): Record<string, string> {
  return {
    "X-Shared-Key": `exporter ${managementKey()}`,
    Cookie: `auth-token=${token ?? ""}`,
  };
}

// Node's fetch reports every transport failure as a bare "fetch failed"; the
// actual reason is buried in a cause chain the logger does not print.
function errorDetail(cause: unknown): string {
  const parts: string[] = [];
  let current: unknown = cause;

  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    const error = current as { code?: unknown; message?: unknown; cause?: unknown };
    const code = typeof error.code === "string" ? error.code : undefined;
    const message = typeof error.message === "string" ? error.message : String(current);
    parts.push(code === undefined ? message : `${code}: ${message}`);
    current = error.cause;
  }

  return parts.join(" <- ");
}

// `fetch!`: a transport failure carries the target uri and the unwrapped cause
// chain, so the log says what went wrong and against which endpoint.
async function fetchOrThrow(uri: string, init: FetchInit): Promise<FetchResponseLike> {
  try {
    return await deps.fetch(uri, init);
  } catch (cause) {
    throw new AppError(
      { hint: "http fetch failed", uri, detail: errorDetail(cause) },
      { cause },
    );
  }
}

function explain(cause: unknown): string {
  const detail = cause instanceof AppError ? cause.data.detail : undefined;
  return typeof detail === "string" ? detail : errorDetail(cause);
}

// --- shape bundle fetch (backend RPC)

interface SceneParams {
  "file-id": string;
  "page-id": string;
  "share-id"?: string;
  token?: string;
  objects: readonly RenderObject[];
}

async function fetchObjects(params: SceneParams): Promise<Record<string, Shape>> {
  const roots = new Set(params.objects.map((object) => object.id));
  const body = transit.encode(
    transit.keywordMap({
      "file-id": transit.uuid(params["file-id"]),
      "page-id": transit.uuid(params["page-id"]),
      "object-id":
        roots.size > 0 ? transit.set([...roots].map((id) => transit.uuid(id))) : undefined,
      "share-id":
        params["share-id"] === undefined ? undefined : transit.uuid(params["share-id"]),
    }),
  );
  const uri = internalUri("api/rpc/command/get-page");

  log.debug({
    hint: "wasm render: get-page",
    uri,
    "file-id": params["file-id"],
    "page-id": params["page-id"],
    roots: roots.size,
  });

  const response = await fetchOrThrow(uri, {
    method: "POST",
    headers: rpcHeaders(params.token),
    body,
  });

  if (response.status !== 200) {
    const text = await response.text();
    log.error({
      hint: "wasm render: get-page failed",
      uri,
      status: response.status,
      body: text,
    });
    throw new AppError({
      hint: "get-page failed",
      status: response.status,
      body: text,
    });
  }

  const decoded = transit.decode<{ objects?: Record<string, Shape> }>(await response.text());
  return decoded.objects ?? {};
}

// --- font resolution
//
// Custom (team) fonts resolve through the file's font variants, google fonts
// through the shared catalog, builtin fonts through the bundled family and the
// frontend's static /fonts/.

export interface CustomFontVariant {
  "font-id"?: string;
  "font-weight"?: number | string;
  "font-style"?: unknown;
  "ttf-file-id"?: string;
}

function styleName(value: unknown): string {
  if (typeof value === "string") return value.replace(/^:/, "");
  return String(value);
}

async function fetchFontVariants(params: SceneParams): Promise<CustomFontVariant[] | undefined> {
  const uri = internalUri("api/rpc/command/get-font-variants");
  const body = transit.encode(
    transit.keywordMap({
      "file-id": transit.uuid(params["file-id"]),
      "share-id":
        params["share-id"] === undefined ? undefined : transit.uuid(params["share-id"]),
    }),
  );

  try {
    const response = await fetchOrThrow(uri, {
      method: "POST",
      headers: rpcHeaders(params.token),
      body,
    });

    if (response.status !== 200) return undefined;
    return transit.decode<CustomFontVariant[]>(await response.text());
  } catch (cause) {
    // A failure here degrades to fallback fonts; it does not fail the export.
    log.warn({
      hint: "wasm render: get-font-variants failed",
      uri,
      detail: explain(cause),
      cause,
    });
    return undefined;
  }
}

async function fetchTtfBytes(uri: string, init: FetchInit): Promise<Uint8Array | undefined> {
  try {
    const response = await deps.fetch(uri, init);
    if (response.status !== 200) return undefined;
    return new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    log.warn({
      hint: "wasm render: font fetch failed",
      uri,
      detail: explain(cause),
      cause,
    });
    return undefined;
  }
}

// TTF bytes cached for the process lifetime, keyed by whatever identifies the
// variant (a gfont id+weight+style, a builtin file name).
const fontBytes = new Map<string, Uint8Array>();

export function clearFontCache(): void {
  fontBytes.clear();
}

async function cachedTtfBytes(
  key: string,
  fetchFn: () => Promise<Uint8Array | undefined>,
): Promise<Uint8Array | undefined> {
  const cached = fontBytes.get(key);
  if (cached !== undefined) return cached;

  const bytes = await fetchFn();
  if (bytes !== undefined) fontBytes.set(key, bytes);
  return bytes;
}

function fetchAssetBytes(
  assetId: string,
  params: SceneParams,
): Promise<Uint8Array | undefined> {
  return fetchTtfBytes(internalUri(`assets/by-id/${assetId}`), {
    method: "GET",
    headers: assetHeaders(params.token),
  });
}

function fetchGfontBytes(ttfUrl: string): Promise<Uint8Array | undefined> {
  return fetchTtfBytes(gstaticToProxyUrl(ttfUrl, internalUri("internal/gfonts/font")), {
    method: "GET",
  });
}

function fetchBuiltinFontBytes(ttfFile: string): Promise<Uint8Array | undefined> {
  return cachedTtfBytes(ttfFile, () =>
    fetchTtfBytes(internalUri(`fonts/${ttfFile}`), { method: "GET" }),
  );
}

function familyUuid(id: Uint32Array): string {
  return uuid.fromUnsignedParts(id[0], id[1], id[2], id[3]);
}

// Custom variant for a family: uuid+weight+style first, degrading to
// uuid+weight then uuid.
function findVariant(
  variants: readonly CustomFontVariant[],
  fontUuid: string,
  weight: number,
  style: number,
): CustomFontVariant | undefined {
  const wanted = style === 0 ? "normal" : "italic";

  return (
    variants.find(
      (variant) =>
        variant["font-id"] === fontUuid &&
        Number(variant["font-weight"]) === weight &&
        styleName(variant["font-style"]) === wanted,
    ) ??
    variants.find(
      (variant) =>
        variant["font-id"] === fontUuid && Number(variant["font-weight"]) === weight,
    ) ??
    variants.find((variant) => variant["font-id"] === fontUuid)
  );
}

// Builds a `resolveFont` fn (family map -> promise of TTF bytes). Custom
// variants first; the bundled fonts for uuid/zero, which is what
// `fontIdToUuid` maps every builtin family to; google catalog otherwise.
function makeResolveFont(
  variants: readonly CustomFontVariant[],
  params: SceneParams,
): (family: FontFamily) => Promise<Uint8Array | undefined> {
  return (family) => {
    const fontUuid = familyUuid(family.id);
    const variant = findVariant(variants, fontUuid, family.weight, family.style);

    if (variant?.["ttf-file-id"] !== undefined) {
      return fetchAssetBytes(variant["ttf-file-id"], params);
    }

    if (fontUuid === uuid.zero) {
      const file = resolveTtfFile(family.weight, family.style);
      return file === undefined ? Promise.resolve(undefined) : fetchBuiltinFontBytes(file);
    }

    const ttfUrl = resolveTtfUrl(fontUuid, family.weight, family.style);
    return ttfUrl === undefined ? Promise.resolve(undefined) : fetchGfontBytes(ttfUrl);
  };
}

// Builds a `font-url` fn (family map -> public URL of its TTF). The SVG export
// emits one @font-face per family from these.
function makeFontUrl(
  variants: readonly CustomFontVariant[],
): (family: FontFamily) => string | undefined {
  return (family) => {
    const fontUuid = familyUuid(family.id);
    const variant = findVariant(variants, fontUuid, family.weight, family.style);

    if (variant?.["ttf-file-id"] !== undefined) {
      return publicUri(`assets/by-id/${variant["ttf-file-id"]}`);
    }

    if (fontUuid === uuid.zero) {
      const file = resolveTtfFile(family.weight, family.style);
      return file === undefined ? undefined : publicUri(`fonts/${file}`);
    }

    const ttfUrl = resolveTtfUrl(fontUuid, family.weight, family.style);
    return ttfUrl === undefined
      ? undefined
      : gstaticToProxyUrl(ttfUrl, publicUri("internal/gfonts/font"));
  };
}

// --- fallback fonts (emoji + per-script noto fonts)
//
// They render through fallback families that no span names, so `fontsForShapes`
// never reports them. Must run per request, since `clearFonts` empties the
// store; the TTF bytes stay cached per process.

interface TextLikeNode {
  text?: unknown;
  children?: readonly TextLikeNode[];
}

// Fallback font descriptors needed by the scene's text. Deduped because several
// languages map to one noto family and provisioning is concurrent.
export function sceneFallbackFonts(scene: Record<string, Shape>): FallbackFont[] {
  const texts: string[] = [];

  const visit = (node: TextLikeNode): void => {
    if (typeof node.text === "string") texts.push(node.text);
    for (const child of node.children ?? []) visit(child);
  };

  for (const shape of Object.values(scene)) {
    if (shape.type !== "text") continue;
    if (shape.content !== null && typeof shape.content === "object") {
      visit(shape.content as TextLikeNode);
    }
  }

  const emoji = texts.some(containsEmoji);

  let languages = new Set<string>();
  for (const text of texts) languages = collectUsedLanguages(languages, text);

  const fonts = addNotoFonts([], languages);
  const all = emoji ? addEmojiFont(fonts) : fonts;

  const seen = new Set<string>();
  return all.filter((font) => {
    const key = `${font["font-id"]}|${font.weight}|${font.style}|${font["is-emoji"] === true}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Cached by the whole variant, not just `font-id`: `resolveTtfUrl` picks a
// different TTF per weight/style, so a font-id-only key would serve the first
// downloaded variant for every other one.
function fetchFallbackFontBytes(font: FallbackFont): Promise<Uint8Array | undefined> {
  const fontUuid = gfontIdToUuid(font["font-id"]);
  if (fontUuid === undefined) return Promise.resolve(undefined);

  const ttfUrl = resolveTtfUrl(fontUuid, font.weight, font.style);
  if (ttfUrl === undefined) return Promise.resolve(undefined);

  return cachedTtfBytes(
    `${font["font-id"]}|${font.weight}|${font.style}`,
    () => fetchGfontBytes(ttfUrl),
  );
}

async function provisionFallbackFonts(scene: Record<string, Shape>): Promise<void> {
  await Promise.all(
    sceneFallbackFonts(scene).map(async (font) => {
      const fontUuid = gfontIdToUuid(font["font-id"]);
      if (fontUuid === undefined) return;

      const bytes = await fetchFallbackFontBytes(font);
      if (bytes === undefined) {
        log.warn({ hint: "wasm render: fallback font unavailable", "font-id": font["font-id"] });
        return;
      }

      wasm.storeFont(
        {
          id: uuid.getU32(fontUuid),
          weight: font.weight,
          style: font.style,
          emoji: font["is-emoji"] === true,
          fallback: font["is-fallback"] === true,
        },
        bytes,
      );
    }),
  );
}

// --- image resolution
//
// Image fills reference file-media ids; the encoded bytes go straight to
// `_store_image` (Skia decodes, no WebGL), keyed by media uuid so this happens
// once per request rather than per rendered object.

async function fetchFileMediaBytes(
  mediaId: string,
  params: SceneParams,
): Promise<Uint8Array | undefined> {
  const uri = internalUri(`assets/by-file-media-id/${mediaId}`);

  try {
    const response = await deps.fetch(uri, { method: "GET", headers: assetHeaders(params.token) });
    if (response.status !== 200) {
      log.warn({
        hint: "wasm render: image fetch non-200",
        "media-id": mediaId,
        uri,
        status: response.status,
      });
      return undefined;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    log.warn({
      hint: "wasm render: image fetch failed",
      "media-id": mediaId,
      uri,
      detail: explain(cause),
      cause,
    });
    return undefined;
  }
}

// Fetches and stores every image the scene references. Unlike fonts, the image
// store is not reset per request, so already-held images are skipped and
// repeated exports of a file reuse them.
//
// Always registers a public media URL for each id so SVG export can emit a
// linked <image href> even when the encoded bytes were already cached.
async function provisionImages(scene: Record<string, Shape>, params: SceneParams): Promise<void> {
  const allIds = [...sceneImageIds(scene)];
  const newIds = allIds.filter((id) => !wasm.imageCached(id));

  log.debug({
    hint: "wasm render: provisioning images",
    total: allIds.length,
    cached: allIds.length - newIds.length,
  });

  for (const imageId of allIds) {
    wasm.storeImageUrl(imageId, publicUri(`assets/by-file-media-id/${imageId}`));
  }

  await Promise.all(
    newIds.map(async (imageId) => {
      const bytes = await fetchFileMediaBytes(imageId, params);
      if (bytes === undefined) {
        log.warn({ hint: "wasm render: image unavailable", "media-id": imageId });
        return;
      }

      log.debug({ hint: "wasm render: image stored", "media-id": imageId, bytes: bytes.byteLength });
      wasm.storeImage(imageId, bytes);
    }),
  );
}

// Recomputes layout for every text shape, once the real fonts are provisioned
// (serialize-time layout used the fallback).
function relayoutText(scene: Record<string, Shape>): void {
  for (const shape of Object.values(scene)) {
    if (shape.type === "text") wasm.updateTextLayout(shape.id);
  }
}

// --- render

// Cancellation is cooperative: a render already inside Skia cannot be
// interrupted, so the flag is only observed between objects.
function checkCancelled(params: HeadlessParams): void {
  if (params["cancelled?"]?.() === true) {
    raise({ type: "internal", code: "job-cancelled", hint: "export job was cancelled" });
  }
}

function renderObjectBytes(type: string, id: string, scale: number): Uint8Array {
  switch (type) {
    case "pdf": {
      const bytes = wasm.renderShapePdf(id, scale);
      log.debug({
        hint: "PDF generated via Skia (render-wasm headless)",
        "object-id": id,
        backend: "skia-wasm",
        bytes: bytes.byteLength,
      });
      return bytes;
    }
    case "svg": {
      const bytes = wasm.renderShapeSvg(id, scale);
      log.debug({
        hint: "SVG generated via Skia (render-wasm headless)",
        "object-id": id,
        backend: "skia-wasm",
        bytes: bytes.byteLength,
      });
      return bytes;
    }
    default:
      return wasm.renderShapeRaster(id, scale, translateRasterFormat(type));
  }
}

async function renderScene(
  params: HeadlessParams,
  onObject: (object: RenderObject) => unknown,
): Promise<void> {
  await ensureModule();

  const scene = await fetchObjects(params);
  log.debug({ hint: "wasm render: scene fetched", shapes: Object.keys(scene).length });

  serializeScene(scene);
  log.debug({ hint: "wasm render: scene serialized" });

  // So fonts from a previous request don't leak into this one.
  wasm.clearFonts();

  const [variants] = await Promise.all([
    fetchFontVariants(params),
    provisionImages(scene, params),
    provisionFallbackFonts(scene),
  ]);

  const custom = variants ?? [];
  // Before rendering, so the relayout below sees real font metrics. Deduped
  // across objects: shapes sharing one family download its TTF once.
  await wasm.provisionFonts(
    params.objects.map((object) => object.id),
    makeResolveFont(custom, params),
    { "font-url": makeFontUrl(custom) },
  );

  relayoutText(scene);

  for (const object of params.objects) {
    checkCancelled(params);

    const bytes = renderObjectBytes(params.type, object.id, params.scale);
    const path = deps.tempfile({
      prefix: "penpot.tmp.wasm.",
      suffix: getExtension(params.type as ExportType),
    });

    log.debug({
      hint: "wasm render: object rendered",
      "object-id": object.id,
      bytes: bytes.byteLength,
    });
    deps.writeFile(path, bytes);

    await onObject({ ...object, path });
  }

  // After the request, never mid-render, so an image can't disappear under a
  // running export.
  const evicted = wasm.evictImages(get("wasm-worker-image-cache-size", wasm.imageCacheSize));
  if (evicted > 0) {
    log.info({ hint: "wasm render: evicted cached images", count: evicted });
  }
}

// Public entry. Renders every object of `params`, calling `onObject` with
// `{id, filename, path, ...}` as each one is written out.
export async function render(
  params: HeadlessParams,
  onObject: (object: RenderObject) => unknown,
): Promise<void> {
  log.debug({
    hint: "wasm render: start",
    type: params.type,
    scale: params.scale,
    objects: params.objects.length,
    "file-id": params["file-id"],
    "page-id": params["page-id"],
  });

  try {
    await renderScene(params, onObject);
  } catch (cause) {
    log.error({
      hint: "wasm render: failed",
      detail: explain(cause),
      "internal-uri": getInternalUri(),
      cause,
    });
    // A panic can leave the mem buffer allocated or the instance aborted; drop
    // it so the next request rebuilds a fresh one.
    modulePromise = undefined;
    wasm.reset();
    throw cause;
  }
}