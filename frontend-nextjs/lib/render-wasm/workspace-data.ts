// The workspace file load through the compiled decoder (F9.1), the port of
// app.main.data.workspace's fetch-bundle -> resolve-file. Same value-bridge
// reasoning as lib/render-wasm/values.ts: get-file answers transit text, and
// routing it through $APP's decode-str keeps uuids, keywords and pointers as
// CLJS values. The two pointer passes and the fragment reads are shared with
// the viewer's loader; only the top-level cleanup differs (below).
//
// Differences from values.ts, documented:
// - The command is get-file, the workspace's own read; there is no share-id.
// - After both pointer passes the compiled resolve-file removes every
//   top-level entry whose value is still a pointer (d/removem); the port
//   rebuilds the map without those entries.
// - The features set is the full supported-features list. The compiled
//   initialize-file prefers the team's enabled set; the shell does not track
//   team features yet, and the full set is a superset.

import { supportedFeatures } from "@/lib/file-data";
import { cmdRaw } from "@/lib/rpc";
import { set as transitSet } from "@/lib/transit";
import {
  KEY,
  arrayMap,
  call,
  get,
  keyword,
  uuid,
  type RendererApp,
} from "./interop";
import { resolveBundlePointers } from "./values";

export interface DecodedWorkspaceFile {
  // The decoded get-file payload with :data replaced by the resolved map.
  file: unknown;
  // The resolved :data (resolved pages-index plus the remaining top-level
  // entries).
  fileData: unknown;
}

export function fetchWorkspaceFileText(fileId: string): Promise<string> {
  return cmdRaw("get-file", {
    id: fileId,
    features: transitSet(supportedFeatures),
  });
}

// (d/removem (comp t/pointer? val) data): rebuild the map without the entries
// whose value is still a pointer after the fragment reads.
function removePointerEntries(app: RendererApp, coll: unknown): unknown {
  let out = arrayMap(app, []);
  let s = call(app, KEY.seq, coll);
  while (s !== null && s !== undefined) {
    const entry = call(app, KEY.first, s);
    const k = call(app, KEY.first, entry);
    const v = call(app, KEY.val, entry);
    if (call(app, KEY.pointerQmark, v) !== true) {
      out = call(app, KEY.assoc, out, k, v);
    }
    s = call(app, KEY.next, s);
  }
  return out;
}

// The full load: raw text, CLJS decode, pointer resolution, top-level cleanup.
export async function fetchDecodedWorkspaceFile(
  app: RendererApp,
  fileId: string,
): Promise<DecodedWorkspaceFile> {
  const raw = await fetchWorkspaceFileText(fileId);
  const file = call(app, KEY.decodeStr, raw);
  const fileData = get(app, file, keyword(app, "data"));
  const resolved = await resolveBundlePointers(app, fileData, { fileId });
  const cleaned = removePointerEntries(app, resolved);
  const fileWithData = call(app, KEY.assoc, file, keyword(app, "data"), cleaned);
  return { file: fileWithData, fileData: cleaned };
}

// The page's :objects map for initialize-viewport, from the resolved data.
export function workspacePageObjects(
  app: RendererApp,
  fileData: unknown,
  pageId: string,
): unknown {
  const pagesIndex = get(app, fileData, keyword(app, "pages-index"));
  const page = get(app, pagesIndex, uuid(app, pageId));
  return get(app, page, keyword(app, "objects"));
}

// Cached variant: one load per app and file, shared across mounts (the
// loader runs from effects that StrictMode double-invokes). A failed load is
// evicted so a retry fetches again — same contract as loadDecodedBundle.
const decodedFiles = new WeakMap<
  RendererApp,
  Map<string, Promise<DecodedWorkspaceFile>>
>();

export function loadDecodedWorkspaceFile(
  app: RendererApp,
  fileId: string,
): Promise<DecodedWorkspaceFile> {
  let cache = decodedFiles.get(app);
  if (cache === undefined) {
    cache = new Map();
    decodedFiles.set(app, cache);
  }
  let entry = cache.get(fileId);
  if (entry === undefined) {
    entry = fetchDecodedWorkspaceFile(app, fileId).catch((error: unknown) => {
      cache.delete(fileId);
      throw error;
    });
    cache.set(fileId, entry);
  }
  return entry;
}
