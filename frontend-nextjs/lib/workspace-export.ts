// Workspace shape export (G1): the server branch of
// app.main.data.exports.assets (request-simple-export / request-export) plus
// the payload the exporter's POST /api/export expects.
//
// The CLJS app renders a shape in the browser through render-wasm when the
// renderer flag is on, and otherwise asks the exporter service. This build
// ships no export entry point on the compiled $APP object (probed against
// public/js/shared.js), so the shell always takes the server branch: one
// transit POST to /api/export with :wait true, answered with the finished
// resource {filename, mtype, uri}. A single object with one spec comes back
// as that file; anything else comes back as a zip (exporter/src-ts/app/handlers/
// export-shapes.ts decides, not the client).
//
// Deviations from the CLJS original, documented:
// - No export-state store and no progress widget: the request waits for the
//   resource, so the panel only needs its local "exporting" state.
// - The resource name is the shape name; the CLJS sidebar pre-appends the
//   suffix to :name and still sends :suffix, which the exporter appends
//   again (a doubled suffix). The suffix travels once, inside :suffix.
// - :is-wasm is always true: this shell renders with render-wasm, which is
//   the flag the CLJS sends when the renderer feature is active.
// - The body carries :profile-id from the session: the exporter's ::params
//   requires it and the legacy POST handler conforms the body before it
//   attaches the profile of the auth cookie (exporter/src-ts/app/handlers.ts).

import { triggerDownloadUri } from "./dom";
import { postTransit } from "./rpc";
import { keyword, keywordMap } from "./transit";
import type { ExportSpec, ExportType } from "./workspace-exports";

// The shape fields the exporter needs; the panel and the main menu hand the
// model shape straight in.
export interface ExportShapeRef {
  id: string;
  name?: string;
}

export interface ShapeExports {
  shape: ExportShapeRef;
  specs: readonly ExportSpec[];
}

// One row of the exporter's :exports vector, as a plain model value.
export interface ExportEntry {
  fileId: string;
  pageId: string;
  objectId: string;
  type: ExportType;
  scale: number;
  suffix: string;
  name: string;
}

export interface ExportParams {
  cmd: "export-shapes";
  wait: true;
  "is-wasm": true;
  name: string;
  // The exporter's ::params spec requires it, and the legacy POST handler
  // conforms the body before the session id is attached (src-ts/app/handlers.ts).
  "profile-id": string;
  exports: ExportEntry[];
}

export interface ExportShapesInput {
  fileId: string;
  pageId: string;
  // The signed-in profile; the callers read it from the session.
  profileId: string;
  items: readonly ShapeExports[];
  signal?: AbortSignal;
}

// The finished export: the backend tempfile the exporter uploaded, valid for
// about an hour.
export interface ExportResource {
  filename: string;
  mtype: string;
  uri: string;
}

// normalize-export: a blank name falls back to the object id, so the exporter
// always has something to build a filename from.
function exportName(shape: ExportShapeRef): string {
  const name = shape.name ?? "";
  return name.trim().length > 0 ? name : shape.id;
}

// One entry per spec, in the order the panel shows them. A shape without
// specs contributes nothing.
export function buildExportEntries(
  fileId: string,
  pageId: string,
  items: readonly ShapeExports[],
): ExportEntry[] {
  const entries: ExportEntry[] = [];
  for (const item of items) {
    for (const spec of item.specs) {
      entries.push({
        fileId,
        pageId,
        objectId: item.shape.id,
        type: spec.type,
        scale: spec.scale,
        suffix: spec.suffix,
        name: exportName(item.shape),
      });
    }
  }
  return entries;
}

// The resource name the exporter puts on the single file or the zip: the one
// shape's name, or the first shape's (the CLJS dialog passes the page name
// there; the shell has no dialog and keeps the name the panel shows).
export function exportResourceName(
  items: readonly ShapeExports[],
  entries: readonly ExportEntry[],
): string {
  const first = items[0];
  if (first !== undefined) return exportName(first.shape);
  return entries[0]?.objectId ?? "export";
}

export function exportParams(
  entries: readonly ExportEntry[],
  name: string,
  profileId: string,
): ExportParams {
  return {
    cmd: "export-shapes",
    wait: true,
    "is-wasm": true,
    name,
    "profile-id": profileId,
    exports: [...entries],
  };
}

// The wire form: top-level keys become keywords through encodeParams, the
// entries need their own keyword maps (the exporter conforms them with
// clojure.spec, which rejects string keys).
export function exportWireBody(params: ExportParams): Record<string, unknown> {
  return {
    cmd: keyword(params.cmd),
    wait: params.wait,
    "is-wasm": params["is-wasm"],
    name: params.name,
    "profile-id": params["profile-id"],
    exports: params.exports.map((entry) =>
      keywordMap({
        "file-id": entry.fileId,
        "page-id": entry.pageId,
        "object-id": entry.objectId,
        type: keyword(entry.type),
        scale: entry.scale,
        suffix: entry.suffix,
        name: entry.name,
      }),
    ),
  };
}

// request-export over the exporter: POST, wait, download. Resolves with the
// resource so callers can log or test; the download already happened.
export async function exportShapes(input: ExportShapesInput): Promise<ExportResource | null> {
  const entries = buildExportEntries(input.fileId, input.pageId, input.items);
  if (entries.length === 0) return null;
  const params = exportParams(
    entries,
    exportResourceName(input.items, entries),
    input.profileId,
  );
  const resource = await postTransit<ExportResource>("api/export", exportWireBody(params), {
    signal: input.signal,
  });
  if (resource === undefined || resource === null) return null;
  triggerDownloadUri(resource.filename, resource.mtype, resource.uri);
  return resource;
}