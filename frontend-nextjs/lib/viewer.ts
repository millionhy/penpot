// Viewer route group logic (F6.1). Headless port of the data-loading, frame
// selection and zoom slice of app.main.data.viewer, plus the shape-tree
// helpers it leans on (app.common.types.shape-tree, app.common.files.helpers).
//
// Kept free of JSX so it runs in vitest's node environment, like
// lib/dashboard.ts. The views live in app/view/page.tsx and
// components/viewer-*.tsx.
//
// Deviations from the CLJS original, documented:
// - fetch-bundle resolves pointer-mapped fragments in the same two passes
//   (pages-index first, then the top-level data keys); CLJS fans the fragment
//   requests out with merge-map, the shell awaits them with Promise.all.
// - The viewer URL parameters are parsed from a URLSearchParams (the App
//   Router surface) instead of rt/get-params off the state; the names and
//   value shapes are unchanged.
// - update-page-position-data (the WASM text position pass) is deferred to
//   the render-wasm port (F6.4); it needs wasm.api/calculate-position-data.

import { cmd } from "@/lib/rpc";
import { isPointer, set as transitSet } from "@/lib/transit";

// --- Feature set (app.common.features/supported-features) -------------------
//
// The viewer reports every feature the frontend supports (not just the ones
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

// The slice of shape data the viewer frame lists and zoom math read. The
// full file shape is far wider (F9); unknown keys stay accessible through
// the index signature.
export interface ViewerShape {
  id: string;
  type: string;
  name?: string;
  "parent-id"?: string;
  shapes?: string[];
  selrect?: { x: number; y: number; width: number; height: number; x1?: number; y1?: number; x2?: number; y2?: number };
  "hide-in-viewer"?: boolean;
  "layout-item-z-index"?: number;
  layout?: string;
  [key: string]: unknown;
}

export type ViewerObjects = Record<string, ViewerShape>;

// cfh/frame-shape? in app.common.files.helpers: frame-typed shapes; a
// component main instance is also a frame (same shape's :type is :frame).
export function isFrameShape(shape: ViewerShape | null | undefined): shape is ViewerShape {
  return shape !== null && shape !== undefined && shape.type === "frame";
}

// cfh/get-parent-ids-with-index: the list of ancestors and, per ancestor,
// the position of the child within it.
export function getParentIdsWithIndex(
  objects: ViewerObjects,
  shapeId: string,
): [string[], Record<string, number>] {
  const parentList: string[] = [];
  const parentIndices: Record<string, number> = {};
  let current = shapeId;
  for (;;) {
    const parentId = objects[current]?.["parent-id"];
    const parent = parentId ? objects[parentId] : null;
    if (parentId !== undefined && parentId !== null && parent !== null && parent !== undefined && parentId !== current) {
      const children = parent.shapes ?? [];
      parentList.push(parentId);
      parentIndices[parentId] = children.indexOf(current);
      current = parentId;
    } else {
      break;
    }
  }
  return [parentList, parentIndices];
}

// ctt/get-frames: every frame-typed shape of the page, in objects insertion
// order (the transit map keeps the CLJS ordered-map order). The root (zero
// uuid) is skipped, like the `(remove #(= uuid/zero %))` guard.
export function getFrames(objects: ViewerObjects): ViewerShape[] {
  const out: ViewerShape[] = [];
  for (const key of Object.keys(objects)) {
    if (key === ZERO_UUID) continue;
    const shape = objects[key];
    if (shape !== undefined && shape !== null && isFrameShape(shape)) out.push(shape);
  }
  return out;
}

// Private get-base of app.common.types.shape-tree: the closest ancestor both
// shapes share (or the zero uuid), with each child's index inside it.
function getBase(
  idA: string,
  idB: string,
  idParents: Record<string, [string[], Record<string, number>]>,
): [string, number | undefined, number | undefined] {
  const [parentsA, parentsAIndex] = idParents[idA] ?? [[], {}];
  const [parentsB, parentsBIndex] = idParents[idB] ?? [[], {}];

  const seqA = [idA, ...parentsA];
  const setB = new Set([idB, ...parentsB]);
  const baseId = seqA.find((id) => setB.has(id)) ?? ZERO_UUID;

  return [baseId, parentsAIndex[baseId], parentsBIndex[baseId]];
}

// ctl/any-layout?: a frame with an auto (flex or grid) layout.
function anyLayout(shape: ViewerShape | null | undefined): boolean {
  if (shape === null || shape === undefined) return false;
  return isFrameShape(shape) && (shape.layout === "flex" || shape.layout === "grid");
}

// ctl/layout-z-index: the item's explicit z-index inside a layout, 0 default.
function layoutZIndex(shape: ViewerShape | null | undefined): number {
  const value = shape?.["layout-item-z-index"];
  return typeof value === "number" ? value : 0;
}

// Private is-shape-over-shape? of app.common.types.shape-tree: whether
// `overShapeId` paints above `baseShapeId` within their common base.
function isShapeOverShape(
  objects: ViewerObjects,
  baseShapeId: string,
  overShapeId: string,
  bottomFrames: boolean,
  idParents: Record<string, [string[], Record<string, number>]>,
): boolean {
  const [baseId, indexA, indexB] = getBase(baseShapeId, overShapeId, idParents);

  // The base is one of the two shapes: the other sits directly under/over it.
  if (baseId === baseShapeId) {
    return bottomFrames && isFrameShape(objects[baseShapeId]);
  }
  if (baseId === overShapeId) {
    return !bottomFrames || !isFrameShape(objects[baseId]);
  }

  const baseShape = objects[baseId];
  const layerOrder = anyLayout(baseShape);
  if (layerOrder && baseShape !== undefined) {
    const children = baseShape.shapes ?? [];
    const zA = layoutZIndex(indexA !== undefined ? objects[children[indexA]] : null);
    const zB = layoutZIndex(indexB !== undefined ? objects[children[indexB]] : null);
    if (zA === zB) return (indexA ?? 0) > (indexB ?? 0);
    return zA < zB;
  }
  // Both deferred to their position inside the base.
  return (indexA ?? 0) < (indexB ?? 0);
}

// ctt/sort-z-index-objects without the bottom-frames? override, which the
// viewer never passes: sort the given shapes back-to-front.
export function sortZIndexObjects(objects: ViewerObjects, items: ViewerShape[]): ViewerShape[] {
  const idParents: Record<string, [string[], Record<string, number>]> = {};
  for (const item of items) {
    idParents[item.id] = getParentIdsWithIndex(objects, item.id);
  }

  return [...items].sort((shapeA, shapeB) => {
    if (shapeA.id === shapeB.id) return 0;
    return isShapeOverShape(objects, shapeA.id, shapeB.id, false, idParents) ? 1 : -1;
  });
}

// ctt/get-viewer-frames: the frames a viewer shows, in z-index order.
// all-frames? keeps the ones hidden from the viewer (overlay targets).
export function getViewerFrames(
  objects: ViewerObjects,
  options: { allFrames?: boolean } = {},
): ViewerShape[] {
  const frames = sortZIndexObjects(objects, getFrames(objects));
  if (options.allFrames === true) return frames;
  return frames.filter((frame) => frame["hide-in-viewer"] !== true);
}

// --- Bundle fetching --------------------------------------------------------

export interface ViewerPageOptions {
  flows?: { id: string; name: string; "starting-frame": string }[];
  [key: string]: unknown;
}

export interface ViewerPageData {
  id: string;
  name?: string;
  objects: ViewerObjects;
  options?: ViewerPageOptions;
  [key: string]: unknown;
}

export interface ViewerFileData {
  id?: string;
  pages: string[];
  "pages-index": Record<string, ViewerPageData>;
  components?: Record<string, unknown>;
  options?: ViewerPageOptions;
  [key: string]: unknown;
}

export interface ViewerFileSummary {
  id: string;
  name: string;
  revn?: number;
  data: ViewerFileData;
  [key: string]: unknown;
}

export interface ViewerLibrary {
  id: string;
  name: string;
  data?: ViewerFileData;
  [key: string]: unknown;
}

export interface ViewerBundle {
  users: { id: string; [key: string]: unknown }[];
  profiles: { id: string; [key: string]: unknown }[];
  fonts: { id: string; [key: string]: unknown }[];
  project: { id: string; name: string; "team-id": string };
  "share-links": { id: string; [key: string]: unknown }[];
  libraries: ViewerLibrary[];
  file: ViewerFileSummary;
  team: { id: string; [key: string]: unknown };
  permissions: unknown;
}

// One page of the viewer: the page data plus the two frame lists the CLJS
// bundle-fetched derives inline (:frames hides viewer-hidden frames,
// :all-frames keeps them for overlay lookups).
export interface ViewerPage extends ViewerPageData {
  frames: ViewerShape[];
  allFrames: ViewerShape[];
}

export type FragmentFetcher = (fragmentId: string) => Promise<unknown>;

// The resolve step of fetch-bundle: a pointer-mapped value loads through
// get-file-fragment and replaces the pointer in place.
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

// The two-pass pointer resolution of fetch-bundle: pages-index first, then
// the top-level data keys (the pass also walks the freshly resolved
// pages-index, exactly like the CLJS stream does).
export async function resolveViewerFileData(
  fileData: ViewerFileData,
  fetchFragment: FragmentFetcher,
): Promise<ViewerFileData> {
  const pagesIndex = await resolvePointerMap(fileData["pages-index"] ?? {}, fetchFragment);
  const data: Record<string, unknown> = { ...fileData, "pages-index": pagesIndex };
  const resolved = await resolvePointerMap(data, fetchFragment);
  return resolved as unknown as ViewerFileData;
}

export interface FetchViewerBundleInput {
  fileId: string;
  shareId?: string | null;
}

// fetch-bundle: the view-only bundle plus its lazy fragments. Anonymous
// visitors are allowed (the RPC is ::rpc/auth false, gated by share-link
// permissions instead).
export async function fetchViewerBundle(input: FetchViewerBundleInput): Promise<ViewerBundle> {
  const { fileId } = input;
  const shareId = input.shareId ?? null;
  const shareParam = shareId !== null && shareId.length > 0 ? { "share-id": shareId } : {};

  const bundle = await cmd<ViewerBundle>("get-view-only-bundle", {
    "file-id": fileId,
    features: transitSet(supportedFeatures),
    ...shareParam,
  });

  const fetchFragment: FragmentFetcher = async (fragmentId) => {
    const response = await cmd<{ data: unknown }>("get-file-fragment", {
      "file-id": fileId,
      "fragment-id": fragmentId,
      ...shareParam,
    });
    return response.data;
  };

  const data = await resolveViewerFileData(bundle.file.data, fetchFragment);
  return { ...bundle, file: { ...bundle.file, data } };
}

// The pages build of bundle-fetched: every page with its frame lists.
export function buildViewerPages(file: ViewerFileSummary): Record<string, ViewerPage> {
  const data = file.data;
  const pages = data?.pages ?? [];
  const index = data?.["pages-index"] ?? {};
  const out: Record<string, ViewerPage> = {};
  for (const pageId of pages) {
    const page = index[pageId];
    if (page === undefined || page === null) continue;
    const objects = page.objects ?? {};
    out[pageId] = {
      ...page,
      id: page.id ?? pageId,
      frames: getViewerFrames(objects),
      allFrames: getViewerFrames(objects, { allFrames: true }),
    };
  }
  return out;
}

// --- URL parameters ---------------------------------------------------------

export interface ViewerQueryParams {
  fileId: string | null;
  pageId: string | null;
  shareId: string | null;
  index: number | null;
  frameId: string | null;
  section: string | null;
  zoom: string | null;
  interactionsMode: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// parse-long: a strict integer (no decimals, no exponents, no padding).
const INT_RE = /^-?\d+$/;

// uuid/parse: a malformed uuid parses to nil, so callers treat it as absent.
function parseUuid(value: string | null): string | null {
  return value !== null && UUID_RE.test(value) ? value : null;
}

// rt/get-query-param + uuid/parse + parse-long over the viewer parameters.
export function parseViewerQuery(search: URLSearchParams): ViewerQueryParams {
  const indexRaw = search.get("index");
  const index = indexRaw !== null && INT_RE.test(indexRaw) ? Number.parseInt(indexRaw, 10) : null;
  return {
    fileId: parseUuid(search.get("file-id")),
    pageId: parseUuid(search.get("page-id")),
    shareId: parseUuid(search.get("share-id")),
    index,
    frameId: parseUuid(search.get("frame-id")),
    section: search.get("section"),
    zoom: search.get("zoom"),
    interactionsMode: search.get("interactions-mode"),
  };
}

// --- Frame selection --------------------------------------------------------

// zoom-to-fit / zoom-to-fill pick the current frame with
// (min (or index 0) (max 0 (dec (count frames)))); a negative index passes
// through untouched, mirroring the CLJS.
export function clampFrameIndex(frames: ViewerShape[], index: number | null): number {
  return Math.min(index ?? 0, Math.max(0, frames.length - 1));
}

// go-to-frame: the index of a frame id, or 0 when it is not on the page.
export function frameIndexById(frames: ViewerShape[], frameId: string): number {
  const index = frames.findIndex((frame) => frame.id === frameId);
  return index === -1 ? 0 : index;
}

// go-to-frame-auto: the first flow's starting frame wins, then index 0.
export function autoFrameIndex(page: ViewerPage): number {
  const flows = page.options?.flows ?? [];
  if (flows.length > 0) {
    return frameIndexById(page.frames, flows[0]["starting-frame"]);
  }
  return 0;
}

// select-prev-frame / select-next-frame bounds. The CLJS events navigate only
// when the neighbour exists; index comes from the URL, which bundle-fetched
// has already normalized to a number by the time navigation is available.
export function canSelectPrev(index: number): boolean {
  return Number.isFinite(index) && index > 0;
}

export function canSelectNext(index: number, totalFrames: number): boolean {
  return Number.isFinite(index) && index < totalFrames - 1;
}

// --- Zoom -------------------------------------------------------------------

export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 200;
export const ZOOM_STEP = 1.3;

// increase-zoom / decrease-zoom: the raw zoom factor updates (zoom-type is
// dropped, the caller owns that part of the state).
export function increaseZoom(zoom: number): number {
  return Math.min(zoom * ZOOM_STEP, MAX_ZOOM);
}

export function decreaseZoom(zoom: number): number {
  return Math.max(zoom / ZOOM_STEP, MIN_ZOOM);
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface Rect {
  width: number;
  height: number;
}

// zoom-to-fit: the smaller ratio so the whole frame fits.
export function fitZoom(viewportSize: ViewportSize, rect: Rect): number {
  return Math.min(viewportSize.width / rect.width, viewportSize.height / rect.height);
}

// zoom-to-fill: the larger ratio so the frame covers the viewport.
export function fillZoom(viewportSize: ViewportSize, rect: Rect): number {
  return Math.max(viewportSize.width / rect.width, viewportSize.height / rect.height);
}

// update-zoom-querystring: the URL mirrors the zoom-type (:fit/:fill), and
// the query string is only rewritten when it does not already say so.
export function shouldUpdateZoomQuery(current: string | null, zoomType: string | null): boolean {
  return current !== zoomType;
}

// --- Interaction modes ------------------------------------------------------

export const INTERACTIONS_MODES = ["hide", "show", "show-on-click"] as const;
export type InteractionsMode = (typeof INTERACTIONS_MODES)[number];

export function isInteractionsMode(value: string | null): value is InteractionsMode {
  return value !== null && (INTERACTIONS_MODES as readonly string[]).includes(value);
}

// set-interactions-mode keeps :show-interactions in step: :hide off, :show on,
// :show-on-click off until flashed (flash-interactions / flash-done).
export function showInteractionsFor(mode: InteractionsMode): boolean {
  return mode === "show";
}

// --- Local state ------------------------------------------------------------

export interface ViewerLocalState {
  zoom: number;
  zoomType: "fit" | "fill" | null;
  fullscreen: boolean;
  interactionsMode: InteractionsMode;
  showInteractions: boolean;
  selected: Set<string>;
  collapsed: Set<string>;
  hover: string | null;
  shareId: string | null;
  viewportSize: ViewportSize | null;
}

// default-local-state: the viewer opens at zoom 1 with interactions shown on
// click and every comment visible.
export function initialViewerLocalState(shareId: string | null): ViewerLocalState {
  return {
    zoom: 1,
    zoomType: null,
    fullscreen: false,
    interactionsMode: "show-on-click",
    showInteractions: false,
    selected: new Set(),
    collapsed: new Set(),
    hover: null,
    shareId,
    viewportSize: null,
  };
}

// --- Media URIs -------------------------------------------------------------

// cf/resolve-file-media: stored file media is served from
// assets/by-file-media-id; a data-uri wins over the stored blob, and the
// share id rides along as a query parameter when the viewer is in share-link
// mode (set-current-share-id! in the CLJS viewer).
export function resolveFileMedia(
  publicUri: string,
  media: { id: string; "data-uri"?: string | null },
  options: { thumbnail?: boolean; shareId?: string | null } = {},
): string {
  if (media["data-uri"]) return media["data-uri"];
  const base = publicUri.endsWith("/") ? publicUri : publicUri + "/";
  const path = options.thumbnail === true ? media.id + "/thumbnail" : media.id;
  const share = options.shareId ?? null;
  const query = share !== null && share.length > 0 ? "?share-id=" + share : "";
  return base + "assets/by-file-media-id/" + path + query;
}
