// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Port of the shape initialization in `app.common.types.shape` and
// `app.common.geom.proportions`.

import type { Matrix, Point, Rect, Shape, ShapeType } from "./model.ts";
import {
  IDENTITY,
  makeRect,
  rectToCenter,
  rectToPoints,
  shapeToRect,
  transformPoints,
} from "./geometry.ts";
import { calcSelrect, normalizeContent } from "./path.ts";
import { ZERO, next } from "./uuid.ts";
import { isNil, uniqueName, withoutNils } from "./data.ts";
import { fail } from "./errors.ts";

const DEFAULT_COLOR = "#B1B2B5";
const WHITE = "#FFFFFF";
const BLACK = "#000000";

const BASE_FIELDS = new Set([
  "id",
  "name",
  "type",
  "x",
  "y",
  "width",
  "height",
  "rotation",
  "selrect",
  "points",
  "transform",
  "transformInverse",
  "parentId",
  "frameId",
  "flipX",
  "flipY",
]);

/**
 * Low level shape creation. Keeps the record field order and the nil
 * defaults of `create-shape`, then appends the type specific attributes.
 */
export function createShape(attrs: Record<string, unknown>): Shape {
  const shape: Record<string, unknown> = {
    id: attrs.id,
    name: attrs.name ?? null,
    type: attrs.type,
    x: attrs.x ?? null,
    y: attrs.y ?? null,
    width: attrs.width ?? null,
    height: attrs.height ?? null,
    rotation: attrs.rotation ?? 0,
    selrect: attrs.selrect ?? null,
    points: attrs.points ?? null,
    transform: attrs.transform ?? null,
    transformInverse: attrs.transformInverse ?? null,
    parentId: attrs.parentId ?? ZERO,
    frameId: attrs.frameId ?? ZERO,
    flipX: attrs.flipX ?? null,
    flipY: attrs.flipY ?? null,
  };

  for (const [key, value] of Object.entries(attrs)) {
    if (!BASE_FIELDS.has(key)) shape[key] = value;
  }

  return shape as unknown as Shape;
}

function minimalAttrs(type: ShapeType): Record<string, unknown> {
  switch (type) {
    case "rect":
      return {
        type: "rect",
        name: "Rectangle",
        fills: [{ fillColor: DEFAULT_COLOR, fillOpacity: 1 }],
        strokes: [],
        r1: 0,
        r2: 0,
        r3: 0,
        r4: 0,
      };

    case "image":
      return {
        type: "image",
        r1: 0,
        r2: 0,
        r3: 0,
        r4: 0,
        fills: [],
        strokes: [],
      };

    case "frame":
      return {
        frameId: ZERO,
        fills: [{ fillColor: WHITE, fillOpacity: 1 }],
        strokes: [],
        name: "Board",
        shapes: [],
        r1: 0,
        r2: 0,
        r3: 0,
        r4: 0,
        hideFillOnExport: false,
      };

    case "circle":
      return {
        type: "circle",
        name: "Ellipse",
        fills: [{ fillColor: DEFAULT_COLOR, fillOpacity: 1 }],
        strokes: [],
      };

    case "group":
      return {
        type: "group",
        name: "Group",
        fills: [],
        strokes: [],
        shapes: [],
      };

    case "bool":
      return {
        type: "bool",
        name: "Bool",
        fills: [],
        strokes: [],
        shapes: [],
      };

    case "text":
      return { type: "text", name: "Text" };

    // Paths use centered strokes by default.
    case "path":
      return {
        type: "path",
        name: "Path",
        fills: [],
        strokes: [
          {
            strokeStyle: "solid",
            strokeAlignment: "center",
            strokeWidth: 1,
            strokeColor: BLACK,
            strokeOpacity: 1,
          },
        ],
      };

    case "svg-raw":
      return { type: "svg-raw", fills: [], strokes: [] };
  }
}

export function makeMinimalShape(type: ShapeType | "curve"): Shape {
  const kind: ShapeType = type === "curve" ? "path" : type;
  const attrs = minimalAttrs(kind);

  const sized =
    kind === "path" || kind === "bool"
      ? { ...attrs, x: null, y: null, width: null, height: null }
      : { ...attrs, x: 0, y: 0, width: 0.01, height: 0.01 };

  return createShape({
    ...sized,
    id: next(),
    frameId: ZERO,
    parentId: ZERO,
    rotation: 0,
  });
}

function requireRect(shape: Shape): Rect {
  const selrect = shape.selrect ?? shapeToRect(shape);
  if (selrect == null) {
    fail("assertion", "data-validation", "expected valid shape");
  }
  return selrect;
}

export function setupRect(shape: Shape): Shape {
  const selrect = requireRect(shape);
  const center = rectToCenter(selrect);
  const transform: Matrix = shape.transform ?? IDENTITY;
  const points: Point[] =
    shape.points ?? transformPoints(rectToPoints(selrect), center, transform);

  return { ...shape, selrect, points };
}

export function setupPath(shape: Shape): Shape {
  const content = normalizeContent(shape.content);
  const selrect = shape.selrect ?? calcSelrect(content) ?? makeRect();
  const points = shape.points ?? rectToPoints(selrect);

  return { ...shape, selrect, points, content };
}

export function setupImage(shape: Shape): Shape {
  const metadata = shape.metadata as
    | { width?: number | null; height?: number | null }
    | undefined;

  const width = metadata?.width;
  const height = metadata?.height;

  if (typeof width !== "number" || typeof height !== "number" || height === 0) {
    fail("assertion", "data-validation", "expected valid shape");
  }

  return { ...shape, proportion: width / height, proportionLock: true };
}

function hasImageFills(shape: Shape): boolean {
  const fills = shape.fills;
  return Array.isArray(fills) && fills.length > 0 && fills.every((fill) => !isNil(fill.fillImage));
}

export function setupProportions(shape: Shape): Shape {
  if (shape.type === "svg-raw") {
    const { selrect } = shape;
    return {
      ...shape,
      proportion: selrect == null ? 1 : selrect.width / selrect.height,
      proportionLock: true,
    };
  }

  if (shape.type === "image") return setupImage(shape);
  if (shape.type === "text") return shape;
  if (hasImageFills(shape)) {
    const { selrect } = shape;
    return {
      ...shape,
      proportion: selrect == null ? 1 : selrect.width / selrect.height,
      proportionLock: true,
    };
  }

  return { ...shape, proportion: 1, proportionLock: false };
}

/**
 * Initializes the geometric data of a shape. The props must carry at least
 * `x`, `y`, `width` and `height` for every type but path and bool.
 */
export function setupShape(props: Record<string, unknown>): Shape {
  const minimal = makeMinimalShape(props.type as ShapeType);
  const clean = withoutNils(props);
  let shape = { ...minimal, ...clean } as Shape;

  shape =
    shape.type === "bool" || shape.type === "path"
      ? setupPath(shape)
      : shape.type === "image"
        ? setupImage(setupRect(shape))
        : setupRect(shape);

  if (shape.transform == null) shape = { ...shape, transform: { ...IDENTITY } };
  if (shape.transformInverse == null) {
    shape = { ...shape, transformInverse: { ...IDENTITY } };
  }

  return setupProportions(shape);
}

export function capitalize(value: string): string {
  if (value.length === 0) return value;
  return value[0].toUpperCase() + value.slice(1).toLowerCase();
}

export function defaultShapeName(type: ShapeType): string {
  return type === "frame" ? "Board" : capitalize(type);
}

/** Assigns a name when the shape has none and dedups it per page. */
export function assignShapeName(
  shape: Shape,
  used: ReadonlySet<string>,
): Shape {
  const base =
    shape.name == null ? defaultShapeName(shape.type) : shape.name;
  return { ...shape, name: uniqueName(base, used) };
}

export function checkShape(shape: Shape): Shape {
  if (typeof shape.id !== "string" || shape.id.length === 0) {
    fail("assertion", "data-validation", "expected valid shape");
  }
  if (typeof shape.type !== "string") {
    fail("assertion", "data-validation", "expected valid shape");
  }
  if (typeof shape.name !== "string") {
    fail("assertion", "data-validation", "expected valid shape");
  }
  if (shape.selrect == null || shape.points == null) {
    fail("assertion", "data-validation", "expected valid shape");
  }

  return shape;
}
