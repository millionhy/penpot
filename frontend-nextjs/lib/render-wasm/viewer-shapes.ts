// The plain-data bridge for the viewer hotspot layer (F6.5, engine port of
// G4.5b): the interaction math of lib/viewer-interactions.ts speaks plain
// decoded values, and so does the viewer bundle since lib/render-wasm/bundle
// (keywords and uuids decode to strings, objects-map/v2 to a plain record).
// This module therefore reads the shapes directly, with no $APP in between:
//
// - the prepared map (preparePageObjects) shifted into vbox space,
// - the plain shape slice the interaction math reads,
// - the hotspot entries the SVG layer draws (frame-hotspots* + hotspot*).
//
// Deviations from the CLJS original, documented:
// - prepare-page-objects is ported in lib/render-wasm/prepare.ts over the
//   decoded map; the views of the overlay path (an alignment delta) stay for
//   a later slice, so the main viewport passes a (0, 0) delta.
// - A hotspot without a selrect is skipped instead of drawing a rect of null
//   attributes (cannot happen on decoded objects).
// - transform-str is the engine port transformMatrixString, which prints the
//   same matrix(a, b, c, d, e, f) with six decimals.

import {
  hotspotShapes,
  actionable,
  type InteractionAnimation,
  type InteractionShape,
  type Point,
  type ShapeReader,
  type ViewerInteraction,
} from "../viewer-interactions";
import type { ViewerShape } from "../viewer";
import { transformMatrixString } from "./engine";
import { preparePageObjects } from "./prepare";

type Selrect = NonNullable<ViewerShape["selrect"]>;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readRaw(m: unknown, key: string): unknown {
  return record(m)?.[key];
}

function readNumber(m: unknown, key: string): number | undefined {
  const value = readRaw(m, key);
  return typeof value === "number" ? value : undefined;
}

function readBool(m: unknown, key: string): boolean | undefined {
  const value = readRaw(m, key);
  return typeof value === "boolean" ? value : undefined;
}

function readString(m: unknown, key: string): string | undefined {
  const value = readRaw(m, key);
  return typeof value === "string" ? value : undefined;
}

// Keywords decode to their name string; a missing value answers undefined.
function readKeyword(m: unknown, key: string): string | undefined {
  return readString(m, key);
}

// A uuid decodes to its string form; nil answers null (the shape of the
// decoded side).
function readId(m: unknown, key: string): string | null {
  const value = readRaw(m, key);
  return typeof value === "string" ? value : null;
}

function readIdVector(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

// The frame's selrect as the plain slice (the delta of an overlay viewport
// keeps this raw value: calculate-size and calculate-delta work on the
// unprepared frame, like the CLJS viewer-overlay).
export function readSelrect(value: unknown): Selrect | undefined {
  const v = record(value);
  if (v === undefined) return undefined;
  const num = (key: string): number | undefined => {
    const n = v[key];
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

function readPoint(value: unknown): Point | null {
  const v = record(value);
  if (v === undefined) return null;
  return {
    x: typeof v.x === "number" ? v.x : 0,
    y: typeof v.y === "number" ? v.y : 0,
  };
}

function readAnimation(value: unknown): InteractionAnimation | null {
  const v = record(value);
  if (v === undefined) return null;
  const animationType = readKeyword(v, "animation-type");
  if (animationType !== "dissolve" && animationType !== "slide" && animationType !== "push") {
    return null;
  }
  const way = readKeyword(v, "way");
  const direction = readKeyword(v, "direction");
  return {
    "animation-type": animationType,
    duration: readNumber(v, "duration"),
    easing: readString(v, "easing"),
    way: way === "in" || way === "out" ? way : undefined,
    direction:
      direction === "right" || direction === "left" || direction === "up" || direction === "down"
        ? direction
        : undefined,
    "offset-effect": readBool(v, "offset-effect"),
  };
}

function convertInteraction(m: unknown): ViewerInteraction {
  return {
    "action-type": readKeyword(m, "action-type"),
    "event-type": readKeyword(m, "event-type"),
    destination: readId(m, "destination"),
    url: readString(m, "url"),
    "preserve-scroll": readBool(m, "preserve-scroll"),
    "overlay-pos-type": readKeyword(m, "overlay-pos-type"),
    "position-relative-to": readId(m, "position-relative-to"),
    "close-click-outside": readBool(m, "close-click-outside"),
    "background-overlay": readBool(m, "background-overlay"),
    "overlay-position": readPoint(readRaw(m, "overlay-position")),
    animation: readAnimation(readRaw(m, "animation")),
    delay: readNumber(m, "delay"),
  };
}

function convertInteractions(value: unknown): ViewerInteraction[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: ViewerInteraction[] = [];
  for (const item of value) {
    if (record(item) !== undefined) out.push(convertInteraction(item));
  }
  return out;
}

// One prepared shape as the plain InteractionShape slice. Empty only when
// the value carries no id (cannot happen on decoded objects).
export function convertShape(raw: unknown): InteractionShape {
  return {
    id: readId(raw, "id") ?? "",
    type: readKeyword(raw, "type"),
    name: readString(raw, "name"),
    x: readNumber(raw, "x"),
    y: readNumber(raw, "y"),
    shapes: readIdVector(readRaw(raw, "shapes")),
    selrect: readSelrect(readRaw(raw, "selrect")),
    "frame-id": readId(raw, "frame-id"),
    "parent-id": readId(raw, "parent-id"),
    "fixed-scroll": readBool(raw, "fixed-scroll"),
    interactions: convertInteractions(readRaw(raw, "interactions")),
    hidden: readBool(raw, "hidden"),
  };
}

// The ShapeReader over a prepared objects map, with a per-load cache (the
// interaction math re-reads the same ids several times: children walks,
// parent walks, frame lookups).
export function createShapeReader(
  objects: Readonly<Record<string, unknown>>,
): ShapeReader {
  const cache = new Map<string, InteractionShape | undefined>();
  return (id) => {
    if (cache.has(id)) return cache.get(id);
    const raw = objects[id];
    const converted = raw === undefined ? undefined : convertShape(raw);
    cache.set(id, converted);
    return converted;
  };
}

// vpc/prepare-page-objects for the main viewport, over the decoded map. The
// delta is the alignment offset of an overlay viewport (0, 0 for the main
// one); the render origin adds it separately.
export function prepareAllObjects(
  objects: Readonly<Record<string, unknown>>,
  size: Point,
  delta: Point,
): Record<string, unknown> {
  return preparePageObjects(objects, size, delta);
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
  prepared: Readonly<Record<string, unknown>>,
  reader: ShapeReader,
  frameId: string,
  filter?: (id: string) => boolean,
): HotspotEntry[] {
  const out: HotspotEntry[] = [];
  for (const shape of hotspotShapes(reader, frameId, filter)) {
    const selrect = shape.selrect;
    if (selrect === undefined) continue;
    const raw = prepared[shape.id];
    if (raw === undefined) continue;
    out.push({
      id: shape.id,
      rect: { x: selrect.x, y: selrect.y, width: selrect.width, height: selrect.height },
      transform: transformMatrixString(raw as Record<string, unknown>),
      pointer: actionable(shape.interactions),
      shape,
    });
  }
  return out;
}
