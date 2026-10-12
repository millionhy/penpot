// The CLJS-to-plain bridge for the viewer hotspot layer (F6.5): the hot
// path of viewport-wasm* runs on the compiled objects, but the interaction
// math of lib/viewer-interactions.ts speaks plain decoded values, so this
// module converts the prepared shapes the compiled side produces
// (viewport_common/prepare-objects) into the plain shape slice and collects
// the hotspot entries the SVG layer draws (frame-hotspots* + hotspot*).
//
// Everything here crosses into $APP through interop.ts; the pure logic it
// feeds stays unit-tested in vitest (lib/viewer-interactions.test.ts).
//
// Deviations from the CLJS original, documented:
// - prepare-page-objects was inlined by the optimizer and is not on $APP
//   (runtime-probed undefined), so the port prepares only the current
//   frame's subtree with prepare-objects. The reader therefore answers
//   shapes of that subtree: every lookup of the F6.5 hotspot actions
//   (navigate / prev-screen / open-url) stays inside it. The overlay
//   slice (f65e) prepares each destination frame on demand through the
//   same call.
// - transform-str is a multi-arity dispatcher whose arity properties carry
//   the $ wrapping of this build; interop.call falls back to the direct
//   call, which the dispatcher routes by arguments.length (runtime-probed).
// - A hotspot without a selrect is skipped instead of drawing a rect of
//   null attributes, and a non-string transform falls back to "" (both
//   cannot happen on the prepared data).

import {
  KEY,
  arrayMap,
  call,
  get,
  keyword,
  uuid,
  type RendererApp,
} from "./interop";
import {
  actionable,
  hotspotShapes,
  type InteractionAnimation,
  type InteractionShape,
  type Point,
  type ShapeReader,
  type ViewerInteraction,
} from "../viewer-interactions";
import type { ViewerShape } from "../viewer";

type Selrect = NonNullable<ViewerShape["selrect"]>;

// get() answers CLJS nil as null; these readers normalize to undefined for
// missing values so callers use plain ?? / !== undefined checks.
function readRaw(app: RendererApp, m: unknown, key: string): unknown {
  return get(app, m, keyword(app, key));
}

function readNumber(app: RendererApp, m: unknown, key: string): number | undefined {
  const v = readRaw(app, m, key);
  return typeof v === "number" ? v : undefined;
}

function readBool(app: RendererApp, m: unknown, key: string): boolean | undefined {
  const v = readRaw(app, m, key);
  return typeof v === "boolean" ? v : undefined;
}

function readString(app: RendererApp, m: unknown, key: string): string | undefined {
  const v = readRaw(app, m, key);
  return typeof v === "string" ? v : undefined;
}

function readKeyword(app: RendererApp, m: unknown, key: string): string | undefined {
  const v = readRaw(app, m, key);
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return undefined;
  const n = call(app, KEY.name, v);
  return typeof n === "string" ? n : undefined;
}

// A uuid value as the plain string; nil answers null (the ?? null shape of
// the decoded side).
function readId(app: RendererApp, m: unknown, key: string): string | null {
  const v = readRaw(app, m, key);
  if (v === null || v === undefined) return null;
  const s = call(app, KEY.str, v);
  return typeof s === "string" ? s : null;
}

function readIdVector(app: RendererApp, v: unknown): string[] | undefined {
  if (v === null || v === undefined) return undefined;
  const out: string[] = [];
  let s = call(app, KEY.seq, v);
  while (s !== null && s !== undefined) {
    const item = call(app, KEY.first, s);
    const str = item === null || item === undefined ? null : call(app, KEY.str, item);
    if (typeof str === "string") out.push(str);
    s = call(app, KEY.next, s);
  }
  return out;
}

function readSelrect(app: RendererApp, v: unknown): Selrect | undefined {
  if (v === null || v === undefined) return undefined;
  const num = (key: string): number | undefined => {
    const n = get(app, v, keyword(app, key));
    return typeof n === "number" ? n : undefined;
  };
  const x = num("x");
  const y = num("y");
  const width = num("width");
  const height = num("height");
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return undefined;
  }
  return { x, y, width, height, x1: num("x1"), y1: num("y1"), x2: num("x2"), y2: num("y2") };
}

function readPoint(app: RendererApp, v: unknown): Point | null {
  if (v === null || v === undefined) return null;
  const x = get(app, v, keyword(app, "x"));
  const y = get(app, v, keyword(app, "y"));
  return { x: typeof x === "number" ? x : 0, y: typeof y === "number" ? y : 0 };
}

function readAnimation(app: RendererApp, v: unknown): InteractionAnimation | null {
  if (v === null || v === undefined) return null;
  const animationType = readKeyword(app, v, "animation-type");
  if (animationType !== "dissolve" && animationType !== "slide" && animationType !== "push") {
    return null;
  }
  const way = readKeyword(app, v, "way");
  const direction = readKeyword(app, v, "direction");
  return {
    "animation-type": animationType,
    duration: readNumber(app, v, "duration"),
    easing: readString(app, v, "easing"),
    way: way === "in" || way === "out" ? way : undefined,
    direction:
      direction === "right" || direction === "left" || direction === "up" || direction === "down"
        ? direction
        : undefined,
    "offset-effect": readBool(app, v, "offset-effect"),
  };
}

function convertInteraction(app: RendererApp, m: unknown): ViewerInteraction {
  return {
    "action-type": readKeyword(app, m, "action-type"),
    "event-type": readKeyword(app, m, "event-type"),
    destination: readId(app, m, "destination"),
    url: readString(app, m, "url"),
    "preserve-scroll": readBool(app, m, "preserve-scroll"),
    "overlay-pos-type": readKeyword(app, m, "overlay-pos-type"),
    "position-relative-to": readId(app, m, "position-relative-to"),
    "close-click-outside": readBool(app, m, "close-click-outside"),
    "background-overlay": readBool(app, m, "background-overlay"),
    "overlay-position": readPoint(app, readRaw(app, m, "overlay-position")),
    animation: readAnimation(app, readRaw(app, m, "animation")),
    delay: readNumber(app, m, "delay"),
  };
}

function convertInteractions(app: RendererApp, v: unknown): ViewerInteraction[] | undefined {
  if (v === null || v === undefined) return undefined;
  const out: ViewerInteraction[] = [];
  let s = call(app, KEY.seq, v);
  while (s !== null && s !== undefined) {
    out.push(convertInteraction(app, call(app, KEY.first, s)));
    s = call(app, KEY.next, s);
  }
  return out;
}

// One prepared CLJS shape as the plain InteractionShape slice. Empty only
// when the value carries no id (cannot happen on decoded objects).
export function convertShape(app: RendererApp, raw: unknown): InteractionShape {
  return {
    id: readId(app, raw, "id") ?? "",
    type: readKeyword(app, raw, "type"),
    name: readString(app, raw, "name"),
    x: readNumber(app, raw, "x"),
    y: readNumber(app, raw, "y"),
    shapes: readIdVector(app, readRaw(app, raw, "shapes")),
    selrect: readSelrect(app, readRaw(app, raw, "selrect")),
    "frame-id": readId(app, raw, "frame-id"),
    "parent-id": readId(app, raw, "parent-id"),
    "fixed-scroll": readBool(app, raw, "fixed-scroll"),
    interactions: convertInteractions(app, readRaw(app, raw, "interactions")),
    hidden: readBool(app, raw, "hidden"),
  };
}

// The ShapeReader over a prepared objects map, with a per-load cache (the
// interaction math re-reads the same ids several times: children walks,
// parent walks, frame lookups).
export function createShapeReader(app: RendererApp, objects: unknown): ShapeReader {
  const cache = new Map<string, InteractionShape | undefined>();
  return (id) => {
    if (cache.has(id)) return cache.get(id);
    const raw = get(app, objects, uuid(app, id));
    const converted = raw === null || raw === undefined ? undefined : convertShape(app, raw);
    cache.set(id, converted);
    return converted;
  };
}

// vpc/prepare-objects: the frame subtree shifted into vbox space by
// -(size + delta). The caller passes the padded bounds origin and (0, 0),
// the delta of the current viewport (viewer.cljs viewer-wrapper).
export function prepareObjects(
  app: RendererApp,
  frame: unknown,
  size: Point,
  delta: Point,
  objects: unknown,
): unknown {
  const sizeMap = arrayMap(app, [
    [keyword(app, "x"), size.x],
    [keyword(app, "y"), size.y],
  ]);
  const deltaMap = arrayMap(app, [
    [keyword(app, "x"), delta.x],
    [keyword(app, "y"), delta.y],
  ]);
  return call(app, KEY.prepareObjects, frame, sizeMap, deltaMap, objects);
}

// One drawable hotspot: the plain shape for the handlers plus the SVG rect
// geometry (prepared selrect, inflated by 1 px) and the prepared shape's
// CSS transform.
export interface HotspotEntry {
  id: string;
  rect: { x: number; y: number; width: number; height: number };
  transform: string;
  pointer: boolean;
  shape: InteractionShape;
}

// frame-hotspots* over the prepared map: the entries of the SVG layer, in
// the (cons frame-id children) order. The reader answers the prepared
// shapes; prepared only supplies the raw shape for transform-str.
export function collectHotspots(
  app: RendererApp,
  prepared: unknown,
  reader: ShapeReader,
  frameId: string,
  filter?: (id: string) => boolean,
): HotspotEntry[] {
  const out: HotspotEntry[] = [];
  for (const shape of hotspotShapes(reader, frameId, filter)) {
    const selrect = shape.selrect;
    if (selrect === undefined) continue;
    const raw = get(app, prepared, uuid(app, shape.id));
    if (raw === null || raw === undefined) continue;
    const transform = call(app, KEY.transformStr, raw);
    out.push({
      id: shape.id,
      rect: { x: selrect.x, y: selrect.y, width: selrect.width, height: selrect.height },
      transform: typeof transform === "string" ? transform : "",
      pointer: actionable(shape.interactions),
      shape,
    });
  }
  return out;
}
