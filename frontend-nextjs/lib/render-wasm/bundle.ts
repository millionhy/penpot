// The viewer bundle as plain decoded values (G4.5b).
//
// The viewer routes run on the TypeScript engine, which reads plain objects,
// so this module performs the fetch with lib/transit:
//
//   get-view-only-bundle -> t/decode-str -> pointer resolution
//
// The pointer resolution mirrors app.main.data.viewer/fetch-bundle: first
// the pages-index entries (the page fragments), then the top-level data keys
// over the rebuilt map. A pointer anywhere else is left as it is, exactly
// like the CLJS passes, which only look at those two levels.
//
// The /dev page still uses the CLJS decoder in values.ts; it goes away with
// that page in G4.7.

import { supportedFeatures } from "@/lib/file-data";
import { cmdRaw } from "@/lib/rpc";
import { decodeTransit, isPointer, set as transitSet } from "@/lib/transit";

export interface BundleInput {
  fileId: string;
  shareId?: string | null;
}

export type JsonObject = Record<string, unknown>;

export interface DecodedBundle {
  // The whole decoded payload: team, fonts, libraries, thumbnails, file...
  payload: JsonObject;
  // (:file payload)
  file: JsonObject;
  // (:data file) with the pointer-mapped values resolved.
  fileData: JsonObject;
}

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

// fetch-bundle reports every supported feature (not only the team-enabled
// ones): an anonymous share-link visitor cannot read the team, so the
// backend cannot intersect the two sets.
function bundleParams(input: BundleInput): Record<string, unknown> {
  const params: Record<string, unknown> = {
    "file-id": input.fileId,
    features: transitSet(supportedFeatures),
  };
  const shareId = input.shareId ?? null;
  if (shareId !== null) params["share-id"] = shareId;
  return params;
}

// t/decode-str over the plain reader: keywords and uuids land as strings,
// objects-map/v2 shapes decode eagerly and path-data arrives as a PathData
// instance.
export function decodeBundleText(raw: string): DecodedBundle {
  const payload = decodeTransit<JsonObject>(raw);
  const file = asObject(payload.file) ?? {};
  const fileData = asObject(file.data) ?? {};
  return { payload, file, fileData };
}

export type FragmentLoader = (fragmentId: string) => Promise<unknown>;

async function fetchFragment(input: BundleInput, fragmentId: string): Promise<unknown> {
  const params: Record<string, unknown> = {
    "file-id": input.fileId,
    "fragment-id": fragmentId,
  };
  const shareId = input.shareId ?? null;
  if (shareId !== null) params["share-id"] = shareId;
  const raw = await cmdRaw("get-file-fragment", params);
  const payload = decodeTransit<JsonObject>(raw);
  return payload.data;
}

function makeLoader(input: BundleInput, loader?: FragmentLoader): FragmentLoader {
  if (loader !== undefined) return loader;
  return (fragmentId) => fetchFragment(input, fragmentId);
}

async function resolvePointerMap(
  map: JsonObject,
  load: FragmentLoader,
): Promise<JsonObject> {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(map)) {
    out[key] = isPointer(value) ? await load(value.id) : value;
  }
  return out;
}

// The two resolve passes of fetch-bundle. `loader` is injectable so the
// tests drive the pointer path without an RPC round trip.
export async function resolveBundlePointers(
  fileData: JsonObject,
  input: BundleInput,
  loader?: FragmentLoader,
): Promise<JsonObject> {
  const load = makeLoader(input, loader);
  const pagesIndex = asObject(fileData["pages-index"]);
  const resolvedPages =
    pagesIndex === undefined ? fileData["pages-index"] : await resolvePointerMap(pagesIndex, load);
  const data: JsonObject = { ...fileData, "pages-index": resolvedPages };
  return resolvePointerMap(data, load);
}

// The full load: raw transit text, plain decode, pointer resolution.
export async function fetchDecodedBundle(input: BundleInput): Promise<DecodedBundle> {
  const raw = await cmdRaw("get-view-only-bundle", bundleParams(input));
  const bundle = decodeBundleText(raw);
  const fileData = await resolveBundlePointers(bundle.fileData, input);
  const file: JsonObject = { ...bundle.file, data: fileData };
  return { ...bundle, file, fileData };
}

const decodedBundles = new Map<string, Promise<DecodedBundle>>();

function bundleKey(input: BundleInput): string {
  return input.fileId + "|" + (input.shareId ?? "");
}

// One load per file/share pair, shared by the viewport and the thumbnails.
// A failed load is evicted so the next mount retries.
export function loadDecodedBundle(input: BundleInput): Promise<DecodedBundle> {
  const key = bundleKey(input);
  let entry = decodedBundles.get(key);
  if (entry === undefined) {
    entry = fetchDecodedBundle(input).catch((error: unknown) => {
      decodedBundles.delete(key);
      throw error;
    });
    decodedBundles.set(key, entry);
  }
  return entry;
}

export function invalidateDecodedBundle(input: BundleInput): void {
  decodedBundles.delete(bundleKey(input));
}

// (:file :data :pages-index <page-id> :objects)
export function pageObjects(fileData: JsonObject, pageId: string): JsonObject | undefined {
  const pagesIndex = asObject(fileData["pages-index"]);
  if (pagesIndex === undefined) return undefined;
  const page = asObject(pagesIndex[pageId]);
  if (page === undefined) return undefined;
  return asObject(page.objects);
}

export function shapeById(
  objects: Readonly<Record<string, unknown>>,
  shapeId: string,
): JsonObject | undefined {
  return asObject(objects[shapeId]);
}
