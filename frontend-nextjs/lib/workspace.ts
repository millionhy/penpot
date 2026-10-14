// Workspace data layer (F9.1): the file load behind the /workspace route.
//
// Port of fetch-bundle and the private resolve-file of
// app.main.data.workspace, plus the pointer-map resolution of
// app.main.features.pointer-map. Unlike the viewer (F6.1), which loads the
// view-only bundle, the workspace loads the full file through get-file and
// drops the top-level keys that still hold a pointer after resolution
// (d/removem in the private resolve-file).
//
// Kept free of JSX so it runs in vitest's node environment; the views live
// in app/workspace/page.tsx and components/workspace-*.tsx.
//
// Deviations from the CLJS original, documented:
// - The two pointer passes run in order (pages-index first, then the
//   top-level keys) instead of the CLJS zip; the loop is the one shared
//   with the viewer in lib/file-data.
// - The URL parameters are parsed from a URLSearchParams (the App Router
//   surface) instead of rt/get-params off the state; the names and value
//   shapes are unchanged.
// - An unknown ?page-id= falls back to the first page; the CLJS redirects
//   to the bare workspace URL for that case (pages.cljs initialize-page).

import {
  ZERO_UUID,
  parseUuid,
  resolveFileData,
  supportedFeatures,
  type FragmentFetcher,
} from "@/lib/file-data";
import { cmd } from "@/lib/rpc";
import { isPointer, set as transitSet } from "@/lib/transit";

// The slice of shape data the page helpers and the viewport math read. The
// full file shape is far wider (F9); unknown keys stay accessible through
// the index signature.
export interface WorkspaceShape {
  id: string;
  type: string;
  name?: string;
  "parent-id"?: string;
  shapes?: string[];
  points?: { x: number; y: number }[];
  [key: string]: unknown;
}

export type WorkspaceObjects = Record<string, WorkspaceShape>;

export interface WorkspacePageData {
  id: string;
  name?: string;
  objects: WorkspaceObjects;
  background?: string;
  [key: string]: unknown;
}

export interface WorkspaceFileData {
  id?: string;
  pages?: string[];
  "pages-index"?: Record<string, WorkspacePageData>;
  [key: string]: unknown;
}

export interface WorkspaceFile {
  id: string;
  name: string;
  revn?: number;
  data: WorkspaceFileData;
  permissions?: unknown;
  [key: string]: unknown;
}

// fpmap/resolve-file plus the d/removem of the workspace resolve-file: the
// two-pass resolution of lib/file-data, then every top-level key whose
// value is still a pointer dropped.
export async function resolveWorkspaceFileData(
  fileData: WorkspaceFileData,
  fetchFragment: FragmentFetcher,
): Promise<WorkspaceFileData> {
  const resolved = (await resolveFileData(fileData, fetchFragment)) as Record<string, unknown>;
  for (const key of Object.keys(resolved)) {
    if (isPointer(resolved[key])) delete resolved[key];
  }
  return resolved as unknown as WorkspaceFileData;
}

// fetch-bundle: the file plus its lazy fragments, authenticated (::rpc/auth
// true, unlike the viewer's anonymous view-only bundle).
export async function fetchWorkspaceFile(fileId: string): Promise<WorkspaceFile> {
  const file = await cmd<WorkspaceFile>("get-file", {
    id: fileId,
    features: transitSet(supportedFeatures),
  });

  const fetchFragment: FragmentFetcher = async (fragmentId) => {
    const response = await cmd<{ data: unknown }>("get-file-fragment", {
      "file-id": fileId,
      "fragment-id": fragmentId,
    });
    return response.data;
  };

  const data = await resolveWorkspaceFileData(file.data, fetchFragment);
  return { ...file, data };
}

// --- Pages -----------------------------------------------------------------

// go-to-workspace + initialize-page: the page open on load is the
// ?page-id= one; a missing or unknown one falls back to the first page of
// the file.
export function resolvePageId(file: WorkspaceFile, pageId: string | null): string | null {
  const index = file.data["pages-index"] ?? {};
  if (pageId !== null && index[pageId] !== undefined) return pageId;
  return (file.data.pages ?? [])[0] ?? null;
}

// dsh/lookup-page-objects: the objects map of the page; empty when the page
// is missing.
export function pageObjects(file: WorkspaceFile, pageId: string | null): WorkspaceObjects {
  if (pageId === null) return {};
  return (file.data["pages-index"] ?? {})[pageId]?.objects ?? {};
}

// cfh/get-immediate-children: the resolved children of the root; the
// initial viewport fits them.
export function immediateChildren(objects: WorkspaceObjects): WorkspaceShape[] {
  const root = objects[ZERO_UUID];
  const ids = root?.shapes ?? [];
  const out: WorkspaceShape[] = [];
  for (const id of ids) {
    const child = objects[id];
    if (child !== undefined && child !== null) out.push(child);
  }
  return out;
}

// --- URL parameters --------------------------------------------------------

export interface WorkspaceQueryParams {
  fileId: string | null;
  pageId: string | null;
  teamId: string | null;
}

// rt/get-params + uuid/parse over the workspace parameters (the shape of
// the links dashboard's workspace-href builds).
export function parseWorkspaceQuery(search: URLSearchParams): WorkspaceQueryParams {
  return {
    fileId: parseUuid(search.get("file-id")),
    pageId: parseUuid(search.get("page-id")),
    teamId: parseUuid(search.get("team-id")),
  };
}
