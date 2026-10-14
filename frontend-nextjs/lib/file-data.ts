// File-data primitives shared by the viewer and workspace data layers.
// The viewer route group grew these first (F6.1); the workspace load (F9.1)
// reuses them unchanged, so they live here instead of lib/viewer.ts.

import { isPointer } from "@/lib/transit";

// --- Feature set (app.common.features/supported-features) -------------------

// The shell reports every feature the frontend supports (not just the ones
// enabled for a team): anonymous share-link visitors cannot read the team, so
// the backend cannot intersect client and team features otherwise.
export const supportedFeatures: readonly string[] = [
  "fdata/objects-map",
  "fdata/pointer-map",
  "fdata/shape-data-type",
  "fdata/path-data",
  "components/v2",
  "styles/v2",
  "layout/grid",
  "plugins/runtime",
  "tokens/numeric-input",
  "design-tokens/v1",
  "text-editor/v2-html-paste",
  "text-editor/v2",
  "text-editor-wasm/v1",
  "render-wasm/v1",
  "variants/v1",
];

// --- Shape slice ------------------------------------------------------------

// uuid/zero in app.common.uuid. The root of every page objects map.
export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// --- URL parameters ---------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// uuid/parse: a malformed uuid parses to nil, so callers treat it as absent
// (rt/get-query-param hands the raw string through first).
export function parseUuid(value: string | null): string | null {
  return value !== null && UUID_RE.test(value) ? value : null;
}

// --- Fragment resolution ----------------------------------------------------

export type FragmentFetcher = (fragmentId: string) => Promise<unknown>;

// The resolve step of fetch-bundle and pointer-map/resolve-file: a
// pointer-mapped value loads through get-file-fragment and replaces the
// pointer in place.
export async function resolvePointerMap<T = unknown>(
  values: Record<string, T>,
  fetchFragment: FragmentFetcher,
): Promise<Record<string, unknown>> {
  const keys = Object.keys(values);
  const resolved = await Promise.all(
    keys.map(async (key): Promise<[string, unknown]> => {
      const value = values[key];
      if (isPointer(value)) {
        return [key, await fetchFragment(value.id)];
      }
      return [key, value];
    }),
  );
  return Object.fromEntries(resolved);
}

// The two passes of fetch-bundle and resolve-file: pages-index first, then
// the top-level data keys (the second pass walks the freshly resolved
// pages-index, exactly like the CLJS stream does).
export async function resolveFileData<T>(
  fileData: T,
  fetchFragment: FragmentFetcher,
): Promise<T> {
  const record = fileData as Record<string, unknown>;
  const pagesIndex = await resolvePointerMap(
    (record["pages-index"] ?? {}) as Record<string, unknown>,
    fetchFragment,
  );
  const data: Record<string, unknown> = { ...record, "pages-index": pagesIndex };
  const resolved = await resolvePointerMap(data, fetchFragment);
  return resolved as unknown as T;
}
