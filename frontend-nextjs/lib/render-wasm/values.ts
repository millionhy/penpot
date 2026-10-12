// The value bridge (F6.4): file data arrives as raw transit text and is
// decoded by the compiled CLJS decoder. lib/transit.ts cannot do this: its
// transit-js reader normalizes keywords and uuids to plain strings, and the
// render-wasm payloads are typed values (keywords the compiled code looks up
// with get, uuids as map keys, pointer-mapped fragments). Routing the text
// through $APP's own decode-str keeps every value in the CLJS runtime, where
// the penpot transit handlers (objects-map/v2, path-data, pointer...) also
// live. It mirrors fetch-bundle in app.main.data.viewer one call at a time.

import { cmdRaw } from "@/lib/rpc";
import { set as transitSet } from "@/lib/transit";
import { supportedFeatures } from "@/lib/viewer";
import { KEY, arrayMap, call, get, keyword, type RendererApp } from "./interop";

export interface BundleInput {
  fileId: string;
  shareId?: string | null;
}

export interface DecodedBundle {
  // The whole decoded payload; callers that need :team, :fonts or :libraries
  // reach them through get().
  payload: unknown;
  // (:file payload), decoded.
  file: unknown;
  // (:data file) with pointer-mapped values resolved.
  fileData: unknown;
}

// fetch-bundle reports every feature the frontend supports (not just the
// ones enabled for a team): anonymous share-link visitors cannot read the
// team, so the backend cannot intersect client and team features otherwise.
function bundleParams(input: BundleInput): Record<string, unknown> {
  const params: Record<string, unknown> = {
    "file-id": input.fileId,
    features: transitSet(supportedFeatures),
  };
  const shareId = input.shareId ?? null;
  if (shareId !== null) params["share-id"] = shareId;
  return params;
}

// get-view-only-bundle as raw text: the TS transport stays out of the way
// (see the file comment). The command is a GET, so it gets the same retry
// as cmd.
export function fetchBundleText(input: BundleInput): Promise<string> {
  return cmdRaw("get-view-only-bundle", bundleParams(input));
}

// t/decode-str through the compiled decoder: keywords, uuids, ordered maps
// and the penpot handler set all land as CLJS values.
export function decodeBundleText(app: RendererApp, raw: string): DecodedBundle {
  const payload = call(app, KEY.decodeStr, raw);
  const file = get(app, payload, keyword(app, "file"));
  const fileData = get(app, file, keyword(app, "data"));
  return { payload, file, fileData };
}

// The pointer's fragment id: @pointer derefs to a CLJS UUID, str() turns it
// into the plain string the RPC params carry (the backend parses it back,
// ::sm/uuid has a string decoder).
function pointerId(app: RendererApp, pointer: unknown): string {
  const id = call(app, KEY.str, call(app, KEY.deref, pointer));
  if (typeof id !== "string") {
    throw new Error(`render-wasm: pointer deref answered a non-string id (${String(id)})`);
  }
  return id;
}

// get-file-fragment {:file-id :fragment-id [share-id]} answered as raw
// transit; the CLJS original maps the decoded payload to :data.
async function fetchFragment(
  app: RendererApp,
  input: BundleInput,
  fragmentId: string,
): Promise<unknown> {
  const params: Record<string, unknown> = {
    "file-id": input.fileId,
    "fragment-id": fragmentId,
  };
  const shareId = input.shareId ?? null;
  if (shareId !== null) params["share-id"] = shareId;
  const raw = await cmdRaw("get-file-fragment", params);
  return get(app, call(app, KEY.decodeStr, raw), keyword(app, "data"));
}

// The resolve step of fetch-bundle: a pointer-mapped value loads through
// get-file-fragment and replaces the pointer in place. The CLJS original
// fans the fragment requests out with merge-map and rebuilds the map with
// conj; here the rebuild is an assoc loop and the requests run in sequence.
async function resolvePointerMap(
  app: RendererApp,
  map: unknown,
  input: BundleInput,
): Promise<unknown> {
  let out = arrayMap(app, []);
  let s = call(app, KEY.seq, map);
  while (s !== null && s !== undefined) {
    const entry = call(app, KEY.first, s);
    const k = call(app, KEY.first, entry);
    let v = call(app, KEY.val, entry);
    if (call(app, KEY.pointerQmark, v) === true) {
      v = await fetchFragment(app, input, pointerId(app, v));
    }
    out = call(app, KEY.assoc, out, k, v);
    s = call(app, KEY.next, s);
  }
  return out;
}

// The two passes of fetch-bundle: pages-index first, then the top-level data
// keys (the second pass walks the freshly resolved pages-index, exactly like
// the CLJS stream does).
export async function resolveBundlePointers(
  app: RendererApp,
  fileData: unknown,
  input: BundleInput,
): Promise<unknown> {
  const pagesIndex = get(app, fileData, keyword(app, "pages-index"));
  const resolvedPages = await resolvePointerMap(app, pagesIndex, input);
  const data = call(app, KEY.assoc, fileData, keyword(app, "pages-index"), resolvedPages);
  return resolvePointerMap(app, data, input);
}

// The full load: raw text, CLJS decode, pointer resolution.
export async function fetchDecodedBundle(
  app: RendererApp,
  input: BundleInput,
): Promise<DecodedBundle> {
  const raw = await fetchBundleText(input);
  const bundle = decodeBundleText(app, raw);
  const fileData = await resolveBundlePointers(app, bundle.fileData, input);
  return { ...bundle, fileData };
}

// Cached variant for the viewport: one bundle load per app and file/share
// pair, shared by every consumer. The entry resolves to the common decoded
// data, so repeat mounts (route changes back to the viewer, StrictMode
// double effects) skip the RPC. A failed load is evicted, so a retry
// fetches again.
const decodedBundles = new WeakMap<
  RendererApp,
  Map<string, Promise<DecodedBundle>>
>();

export function loadDecodedBundle(
  app: RendererApp,
  input: BundleInput,
): Promise<DecodedBundle> {
  let cache = decodedBundles.get(app);
  if (cache === undefined) {
    cache = new Map();
    decodedBundles.set(app, cache);
  }
  const key = input.fileId + "|" + (input.shareId ?? "");
  let entry = cache.get(key);
  if (entry === undefined) {
    entry = fetchDecodedBundle(app, input).catch((error: unknown) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, entry);
  }
  return entry;
}
