// The resize/rotate rules of lib/workspace-transform.ts: the matrix helpers,
// the selection frame, the handle layout, the resize and rotate gestures, the
// generic apply-transform port and the packed path rewrite. The expectations
// mirror the CLJS sources named in the module header (transforms.cljs,
// modifiers.cljc, geom/shapes/transforms.cljc and impl-transform).

import { describe, expect, it } from "vitest";

import { PathData } from "@/lib/transit";
import {
  IDENTITY_MATRIX,
  applyTransformEntries,
  applyTransformToShape,
  buildTransformEntryChanges,
  frameCorners,
  inverseMatrix,
  isIdentityMatrix,
  isTransformableShape,
  matrixRecord,
  matrixToString,
  multiplyMatrix,
  resizeGesture,
  resizeHandlePoints,
  rotateGesture,
  rotationMatrix,
  rotationZonePoints,
  scaleMatrix,
  selectionGeometry,
  shapeTransformMatrix,
  transformEntries,
  transformPathBytes,
  transformPoint,
  transformShapePatch,
  translationMatrix,
  type Matrix6,
  type Point,
  type SelectionGeometry,
  type TransformEntry,
} from "@/lib/workspace-transform";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

// --- Fixtures ----------------------------------------------------------------

const SELRECT = { x: 0, y: 0, width: 100, height: 50, x1: 0, y1: 0, x2: 100, y2: 50 };
const POINTS = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 50 },
  { x: 0, y: 50 },
];

const IDENTITY_RECORD = matrixRecord(IDENTITY_MATRIX);

function shape(id: string, type: string, extra: Record<string, unknown> = {}): WorkspaceShape {
  return { id, type, ...extra };
}

function rectShape(extra: Record<string, unknown> = {}): WorkspaceShape {
  return shape("rect-1", "rect", {
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    selrect: { ...SELRECT },
    points: POINTS.map((point) => ({ ...point })),
    rotation: 0,
    transform: { ...IDENTITY_RECORD },
    "transform-inverse": { ...IDENTITY_RECORD },
    ...extra,
  });
}

function expectPoint(actual: Point, x: number, y: number): void {
  expect(actual.x).toBeCloseTo(x, 6);
  expect(actual.y).toBeCloseTo(y, 6);
}

function expectMatrix(actual: Matrix6, expected: readonly number[]): void {
  expect(expected).toHaveLength(6);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, 6));
}

// The transform record as a Matrix6 tuple.
function selectMatrix(record: Record<string, number>): Matrix6 {
  return [record.a, record.b, record.c, record.d, record.e, record.f];
}

function geometryOf(extra: Record<string, unknown> = {}): SelectionGeometry {
  const geometry = selectionGeometry({ "rect-1": rectShape(extra) }, ["rect-1"]);
  if (geometry === null) throw new Error("expected a selection geometry");
  return geometry;
}

// --- Packed path helpers -----------------------------------------------------

const SEGMENT = 28;

function packedSegment(type: number, floats: Record<number, number> = {}): Uint8Array {
  const bytes = new Uint8Array(SEGMENT);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, type, true);
  for (const [offset, value] of Object.entries(floats)) {
    view.setFloat32(Number(offset), value, true);
  }
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function readFloat(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(offset, true);
}

// --- Matrices ----------------------------------------------------------------

describe("matrix helpers", () => {
  it("multiplies left to right (m1 · m2)", () => {
    const matrix = multiplyMatrix(translationMatrix(10, 20), scaleMatrix(2, 3));
    expectPoint(transformPoint({ x: 1, y: 1 }, matrix), 12, 23);
  });

  it("builds a clockwise rotation in the y-down frame", () => {
    expectMatrix(rotationMatrix(90), [0, 1, -1, 0, 0, 0]);
    expectPoint(transformPoint({ x: 1, y: 0 }, rotationMatrix(90)), 0, 1);
  });

  it("inverts affine matrices and rejects singular ones", () => {
    const matrix = multiplyMatrix(translationMatrix(10, 20), rotationMatrix(30));
    const inverse = inverseMatrix(matrix);
    expect(inverse).not.toBeNull();
    expectMatrix(multiplyMatrix(matrix, inverse as Matrix6), IDENTITY_MATRIX);
    expect(inverseMatrix(scaleMatrix(0, 0))).toBeNull();
  });

  it("round-trips the transit record and the SVG string", () => {
    const matrix = translationMatrix(1.5, -2);
    expect(matrixRecord(matrix)).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 1.5, f: -2 });
    expect(matrixToString(matrix)).toBe("matrix(1,0,0,1,1.5,-2)");
  });

  it("recognizes the identity matrix", () => {
    expect(isIdentityMatrix(IDENTITY_MATRIX)).toBe(true);
    expect(isIdentityMatrix(translationMatrix(0.00001, 0))).toBe(true);
    expect(isIdentityMatrix(translationMatrix(1, 0))).toBe(false);
  });
});

// --- Selection frame ---------------------------------------------------------

describe("shapeTransformMatrix", () => {
  it("wraps the stored transform in the selrect center", () => {
    const matrix = shapeTransformMatrix(
      rectShape({ transform: matrixRecord(rotationMatrix(90)), rotation: 90 }),
    );
    expectPoint(transformPoint({ x: 50, y: 25 }, matrix), 50, 25);
    expectPoint(transformPoint({ x: 0, y: 25 }, matrix), 50, -25);
  });
});

describe("selectionGeometry", () => {
  it("keeps the single-shape selrect and its center-wrapped transform", () => {
    const geometry = geometryOf({
      transform: matrixRecord(rotationMatrix(90)),
      "transform-inverse": matrixRecord(rotationMatrix(270)),
      rotation: 90,
      "proportion-lock": true,
    });
    expect(geometry.rect).toEqual(SELRECT);
    expect(geometry.rotation).toBe(90);
    expect(geometry.proportionLock).toBe(true);
    expectPoint(geometry.center, 50, 25);
    expectPoint(transformPoint({ x: 0, y: 25 }, geometry.transform), 50, -25);
  });

  it("returns a union of rotated points with the identity frame for multi", () => {
    const objects: WorkspaceObjects = {
      "rect-1": rectShape(),
      "rect-2": rectShape({
        id: "rect-2",
        // The selrect lies at the origin; the union must follow the points.
        points: [
          { x: 200, y: 100 },
          { x: 300, y: 100 },
          { x: 300, y: 200 },
          { x: 200, y: 200 },
        ],
      }),
    };
    const geometry = selectionGeometry(objects, ["rect-1", "rect-2"]);
    expect(geometry).not.toBeNull();
    expect(geometry?.rect).toMatchObject({ x: 0, y: 0, width: 300, height: 200 });
    expect(geometry?.transform).toEqual(IDENTITY_MATRIX);
    expectPoint(geometry?.center as Point, 150, 100);
    expect(geometry?.rotation).toBe(0);
    expect(geometry?.proportionLock).toBe(false);
  });

  it("rejects empty, missing, blocked and text selections", () => {
    const objects: WorkspaceObjects = {
      "rect-1": rectShape(),
      "text-1": shape("text-1", "text", { selrect: { ...SELRECT }, points: POINTS }),
      "rect-2": rectShape({ id: "rect-2", blocked: true }),
    };
    expect(selectionGeometry(objects, [])).toBeNull();
    expect(selectionGeometry(objects, ["missing"])).toBeNull();
    expect(selectionGeometry(objects, ["text-1"])).toBeNull();
    expect(selectionGeometry(objects, ["rect-2"])).toBeNull();
    expect(selectionGeometry(objects, ["rect-1", "text-1"])).toBeNull();
    expect(selectionGeometry({ "no-selrect": shape("no-selrect", "rect") }, ["no-selrect"])).toBeNull();
  });

  it("lists the shape types the handles accept", () => {
    for (const type of ["rect", "circle", "frame", "group", "path", "bool", "image"]) {
      expect(isTransformableShape(shape("s", type))).toBe(true);
    }
    expect(isTransformableShape(shape("s", "text"))).toBe(false);
    expect(isTransformableShape(shape("s", "rect", { blocked: true }))).toBe(false);
    expect(isTransformableShape(null)).toBe(false);
  });
});

// --- Handles -----------------------------------------------------------------

describe("handle layout", () => {
  it("places the eight resize handles at the corners and edge midpoints", () => {
    const handles = resizeHandlePoints(geometryOf());
    expect(handles.map((handle) => handle.handler)).toEqual([
      "top-left",
      "top",
      "top-right",
      "right",
      "bottom-right",
      "bottom",
      "bottom-left",
      "left",
    ]);
    expectPoint(handles[0], 0, 0);
    expectPoint(handles[1], 50, 0);
    expectPoint(handles[2], 100, 0);
    expectPoint(handles[3], 100, 25);
    expectPoint(handles[4], 100, 50);
    expectPoint(handles[5], 50, 50);
    expectPoint(handles[6], 0, 50);
    expectPoint(handles[7], 0, 25);
  });

  it("applies the preview matrix to the handles and the bounds", () => {
    const geometry = geometryOf();
    const preview = translationMatrix(10, 20);
    expectPoint(resizeHandlePoints(geometry, preview)[0], 10, 20);
    expectPoint(frameCorners(geometry, preview)[0], 10, 20);
    expectPoint(frameCorners(geometry, preview)[2], 110, 70);
  });

  it("draws four rotation zones just outside the corners", () => {
    const zones = rotationZonePoints(geometryOf(), 10);
    expect(zones.map((zone) => zone.corner)).toEqual([
      "top-left",
      "top-right",
      "bottom-right",
      "bottom-left",
    ]);
    expect(zones[0].points.map((point) => [point.x, point.y])).toEqual([
      [-10, -10],
      [0, -10],
      [0, 0],
      [-10, 0],
    ]);
    expect(zones[2].points.map((point) => [point.x, point.y])).toEqual([
      [100, 50],
      [110, 50],
      [110, 60],
      [100, 60],
    ]);
  });

  it("returns the rotated world corners for a rotated selection", () => {
    const geometry = geometryOf({
      transform: matrixRecord(rotationMatrix(90)),
      "transform-inverse": matrixRecord(rotationMatrix(270)),
      rotation: 90,
    });
    const corners = frameCorners(geometry);
    expectPoint(corners[0], 75, -25);
    expectPoint(corners[1], 75, 75);
    expectPoint(corners[2], 25, 75);
    expectPoint(corners[3], 25, -25);
  });
});

// --- Resize ------------------------------------------------------------------

describe("resizeGesture", () => {
  it("doubles the width from the right edge and keeps the left edge fixed", () => {
    const result = resizeGesture(geometryOf(), "right", { x: 100, y: 25 }, { x: 200, y: 25 });
    expect(result).not.toBeNull();
    expect(result?.scale).toEqual({ x: 2, y: 1 });
    expectPoint(result?.origin as Point, 0, 25);
    const matrix = result?.matrix as Matrix6;
    expectPoint(transformPoint({ x: 0, y: 0 }, matrix), 0, 0);
    expectPoint(transformPoint({ x: 0, y: 50 }, matrix), 0, 50);
    expectPoint(transformPoint({ x: 100, y: 0 }, matrix), 200, 0);
    expectPoint(transformPoint({ x: 100, y: 50 }, matrix), 200, 50);
  });

  it("doubles the height from the bottom edge and keeps the top fixed", () => {
    const result = resizeGesture(geometryOf(), "bottom", { x: 50, y: 50 }, { x: 50, y: 100 });
    expect(result?.scale).toEqual({ x: 1, y: 2 });
    const matrix = result?.matrix as Matrix6;
    expectPoint(transformPoint({ x: 0, y: 0 }, matrix), 0, 0);
    expectPoint(transformPoint({ x: 100, y: 50 }, matrix), 100, 100);
  });

  it("snaps the press point to the handled edge", () => {
    // The press lands off the edge midpoint; fix-init-point moves it back.
    const result = resizeGesture(geometryOf(), "right", { x: 90, y: 25 }, { x: 200, y: 25 });
    expect(result?.scale).toEqual({ x: 2, y: 1 });
  });

  it("locks both axes on a corner with the largest scale", () => {
    const result = resizeGesture(
      geometryOf(),
      "bottom-right",
      { x: 100, y: 50 },
      { x: 300, y: 100 },
      { lock: true },
    );
    expect(result?.scale).toEqual({ x: 3, y: 3 });
    const matrix = result?.matrix as Matrix6;
    expectPoint(transformPoint({ x: 0, y: 0 }, matrix), 0, 0);
    expectPoint(transformPoint({ x: 100, y: 50 }, matrix), 300, 150);
  });

  it("locks an edge handler to its own axis", () => {
    const result = resizeGesture(
      geometryOf(),
      "right",
      { x: 100, y: 25 },
      { x: 200, y: 25 },
      { lock: true },
    );
    expect(result?.scale).toEqual({ x: 2, y: 2 });
    expectPoint(transformPoint({ x: 100, y: 50 }, result?.matrix as Matrix6), 200, 75);
  });

  it("keeps the center fixed with Alt", () => {
    const result = resizeGesture(
      geometryOf(),
      "right",
      { x: 100, y: 25 },
      { x: 200, y: 25 },
      { center: true },
    );
    expect(result?.scale).toEqual({ x: 2, y: 1 });
    expectPoint(result?.origin as Point, 50, 25);
    const matrix = result?.matrix as Matrix6;
    expectPoint(transformPoint({ x: 50, y: 25 }, matrix), 50, 25);
    expectPoint(transformPoint({ x: 0, y: 0 }, matrix), -50, 0);
    expectPoint(transformPoint({ x: 100, y: 50 }, matrix), 150, 50);
  });

  it("scales a rotated selection along its local axes", () => {
    const geometry = geometryOf({
      transform: matrixRecord(rotationMatrix(45)),
      "transform-inverse": matrixRecord(rotationMatrix(315)),
      rotation: 45,
    });
    const initial = transformPoint({ x: 100, y: 25 }, geometry.transform);
    const current = transformPoint({ x: 200, y: 25 }, geometry.transform);
    const result = resizeGesture(geometry, "right", initial, current);
    expect(result?.scale.x).toBeCloseTo(2, 6);
    expect(result?.scale.y).toBeCloseTo(1, 6);

    const matrix = result?.matrix as Matrix6;
    const leftTop = transformPoint({ x: 0, y: 0 }, geometry.transform);
    const leftBottom = transformPoint({ x: 0, y: 50 }, geometry.transform);
    expectPoint(transformPoint(leftTop, matrix), leftTop.x, leftTop.y);
    expectPoint(transformPoint(leftBottom, matrix), leftBottom.x, leftBottom.y);

    const expectedRightTop = transformPoint({ x: 200, y: 0 }, geometry.transform);
    const actualRightTop = transformPoint(
      transformPoint({ x: 100, y: 0 }, geometry.transform),
      matrix,
    );
    expectPoint(actualRightTop, expectedRightTop.x, expectedRightTop.y);
  });

  it("returns an identity matrix when the pointer did not move", () => {
    const result = resizeGesture(geometryOf(), "right", { x: 100, y: 25 }, { x: 100, y: 25 });
    expect(result?.scale).toEqual({ x: 1, y: 1 });
    expect(isIdentityMatrix(result?.matrix as Matrix6)).toBe(true);
  });

  it("refuses a degenerate selection transform", () => {
    const geometry = { ...geometryOf(), transform: [0, 0, 0, 0, 0, 0] as Matrix6 };
    expect(resizeGesture(geometry, "right", { x: 100, y: 25 }, { x: 200, y: 25 })).toBeNull();
  });
});

// --- Rotation ----------------------------------------------------------------

describe("rotateGesture", () => {
  const CENTER = { x: 50, y: 25 };

  it("reports the angle around the pivot and rotates clockwise", () => {
    const result = rotateGesture(CENTER, { x: 150, y: 25 }, { x: 50, y: 75 });
    expect(result.angle).toBeCloseTo(90, 6);
    expectPoint(transformPoint({ x: 150, y: 25 }, result.matrix), 50, 125);
    expectPoint(transformPoint(CENTER, result.matrix), 50, 25);
  });

  it("normalizes a counter-clockwise drag into 0..360", () => {
    const result = rotateGesture(CENTER, { x: 50, y: 75 }, { x: 150, y: 25 });
    expect(result.angle).toBeCloseTo(270, 6);
  });

  it("snaps to 45 degree steps with mod", () => {
    const point = {
      x: 50 + 100 * Math.cos((60 * Math.PI) / 180),
      y: 25 + 100 * Math.sin((60 * Math.PI) / 180),
    };
    const result = rotateGesture(CENTER, { x: 150, y: 25 }, point, { snap45: true });
    expect(result.angle).toBe(45);
  });

  it("snaps to 15 degree steps with shift", () => {
    const point = {
      x: 50 + 100 * Math.cos((31 * Math.PI) / 180),
      y: 25 + 100 * Math.sin((31 * Math.PI) / 180),
    };
    const result = rotateGesture(CENTER, { x: 150, y: 25 }, point, { snap15: true });
    expect(result.angle).toBe(30);
  });

  it("reports zero for a press and release on the same point", () => {
    const result = rotateGesture(CENTER, { x: 150, y: 25 }, { x: 150, y: 25 });
    expect(result.angle).toBe(0);
    expect(isIdentityMatrix(result.matrix)).toBe(true);
  });
});

// --- applyTransformToShape ---------------------------------------------------

describe("applyTransformToShape", () => {
  it("keeps an untransformed shape as it is", () => {
    const next = applyTransformToShape(rectShape(), IDENTITY_MATRIX);
    expect(next).toMatchObject({ x: 0, y: 0, width: 100, height: 50, rotation: 0 });
    expect(next.selrect).toEqual(SELRECT);
    expectMatrix(selectMatrix(next.transform as Record<string, number>), IDENTITY_MATRIX);
    expectMatrix(
      selectMatrix(next["transform-inverse"] as Record<string, number>),
      IDENTITY_MATRIX,
    );
    expect(next["flip-x"]).toBeUndefined();
  });

  it("moves the points, the box and the selrect with a translation", () => {
    const next = applyTransformToShape(rectShape(), translationMatrix(10, 20));
    expect(next).toMatchObject({ x: 10, y: 20, width: 100, height: 50, rotation: 0 });
    expect(next.selrect).toMatchObject({ x: 10, y: 20, width: 100, height: 50 });
    const points = next.points as Point[];
    expectPoint(points[0], 10, 20);
    expectPoint(points[2], 110, 70);
    expect(next.transform).toEqual(IDENTITY_RECORD);
  });

  it("grows the box with a scale and keeps the transform unit", () => {
    const next = applyTransformToShape(rectShape(), scaleMatrix(2, 1));
    expect(next).toMatchObject({ x: 0, y: 0, width: 200, height: 50 });
    expect(next.transform).toEqual(IDENTITY_RECORD);
  });

  it("adds the rotation delta and rebuilds the center transform", () => {
    const center = { x: 50, y: 25 };
    const matrix = multiplyMatrix(
      multiplyMatrix(translationMatrix(center.x, center.y), rotationMatrix(90)),
      translationMatrix(-center.x, -center.y),
    );
    const next = applyTransformToShape(rectShape(), matrix, 90);
    expect(next.rotation).toBe(90);
    expect(next.selrect).toMatchObject({ x: 0, y: 0, width: 100, height: 50 });
    const points = next.points as Point[];
    expectPoint(points[0], 75, -25);
    expectPoint(points[1], 75, 75);
    expectPoint(points[2], 25, 75);
    expectPoint(points[3], 25, -25);

    // The stored transform is centerless: shapeTransformMatrix wraps it back
    // in the selrect center before it meets the stored points.
    const world = shapeTransformMatrix(next);
    expectPoint(transformPoint({ x: 0, y: 0 }, world), 75, -25);
    expectPoint(transformPoint(center, world), 50, 25);
    const transform = selectMatrix(next.transform as Record<string, number>);
    const inverse = selectMatrix(next["transform-inverse"] as Record<string, number>);
    expectMatrix(multiplyMatrix(transform, inverse), IDENTITY_MATRIX);
  });

  it("toggles only the flipped axis and negates an odd number of flips", () => {
    // Mirror about x = 50: the horizontal edge reverses.
    const mirrorX = multiplyMatrix(translationMatrix(100, 0), scaleMatrix(-1, 1));
    const next = applyTransformToShape(rectShape({ rotation: 30 }), mirrorX, 0);
    expect(next["flip-x"]).toBe(true);
    expect(next["flip-y"]).toBeUndefined();
    expect(next.rotation).toBe(330);
  });

  it("keeps the rotation when both axes flip", () => {
    const mirrorBoth = multiplyMatrix(translationMatrix(100, 50), scaleMatrix(-1, -1));
    const next = applyTransformToShape(rectShape({ rotation: 30 }), mirrorBoth, 0);
    expect(next["flip-x"]).toBe(true);
    expect(next["flip-y"]).toBe(true);
    expect(next.rotation).toBe(30);
  });

  it("rewrites the packed content of a path instead of its box", () => {
    const close = packedSegment(4);
    const content = new PathData(
      concatBytes(
        packedSegment(1, { 20: 0, 24: 0 }),
        packedSegment(2, { 20: 10, 24: 0 }),
        packedSegment(3, { 4: 1, 8: 2, 12: 3, 16: 4, 20: 10, 24: 10 }),
        close,
      ),
    );
    const path = shape("path-1", "path", {
      x: 7,
      y: 8,
      selrect: { ...SELRECT },
      points: POINTS.map((point) => ({ ...point })),
      rotation: 0,
      transform: { ...IDENTITY_RECORD },
      "transform-inverse": { ...IDENTITY_RECORD },
      content,
    });
    const next = applyTransformToShape(path, scaleMatrix(2, 2));
    expect(next.x).toBe(7);
    expect(next.y).toBe(8);
    const bytes = (next.content as PathData).bytes;
    expect(readFloat(bytes, 20)).toBeCloseTo(0, 5);
    expect(readFloat(bytes, 20 + SEGMENT)).toBeCloseTo(20, 5);
    expect(readFloat(bytes, 4 + 2 * SEGMENT)).toBeCloseTo(2, 5);
    expect(readFloat(bytes, 8 + 2 * SEGMENT)).toBeCloseTo(4, 5);
    expect(readFloat(bytes, 12 + 2 * SEGMENT)).toBeCloseTo(6, 5);
    expect(readFloat(bytes, 16 + 2 * SEGMENT)).toBeCloseTo(8, 5);
    expect(readFloat(bytes, 20 + 2 * SEGMENT)).toBeCloseTo(20, 5);
    expect(readFloat(bytes, 24 + 2 * SEGMENT)).toBeCloseTo(20, 5);
    expect(bytes.subarray(3 * SEGMENT, 4 * SEGMENT)).toEqual(close);
  });
});

// --- Packed path transform ---------------------------------------------------

describe("transformPathBytes", () => {
  it("transforms endpoints and curve handles but not close segments", () => {
    const close = packedSegment(4);
    const bytes = concatBytes(
      packedSegment(1, { 20: 1, 24: 2 }),
      packedSegment(2, { 20: 3, 24: 4 }),
      packedSegment(3, { 4: 5, 8: 6, 12: 7, 16: 8, 20: 9, 24: 10 }),
      close,
    );
    const next = transformPathBytes(bytes, translationMatrix(10, 20));
    expect(readFloat(next, 20)).toBeCloseTo(11, 5);
    expect(readFloat(next, 24)).toBeCloseTo(22, 5);
    expect(readFloat(next, 20 + SEGMENT)).toBeCloseTo(13, 5);
    expect(readFloat(next, 24 + SEGMENT)).toBeCloseTo(24, 5);
    expect(readFloat(next, 4 + 2 * SEGMENT)).toBeCloseTo(15, 5);
    expect(readFloat(next, 8 + 2 * SEGMENT)).toBeCloseTo(26, 5);
    expect(readFloat(next, 12 + 2 * SEGMENT)).toBeCloseTo(17, 5);
    expect(readFloat(next, 16 + 2 * SEGMENT)).toBeCloseTo(28, 5);
    expect(readFloat(next, 20 + 2 * SEGMENT)).toBeCloseTo(19, 5);
    expect(readFloat(next, 24 + 2 * SEGMENT)).toBeCloseTo(30, 5);
    expect(next.subarray(3 * SEGMENT, 4 * SEGMENT)).toEqual(close);
    // The source stays untouched.
    expect(readFloat(bytes, 20)).toBeCloseTo(1, 5);
  });
});

// --- Change building ---------------------------------------------------------

describe("buildTransformEntryChanges", () => {
  it("emits one mod-obj per shape with only the changed attributes", () => {
    const objects: WorkspaceObjects = {
      "rect-1": rectShape(),
      "rect-2": rectShape({ id: "rect-2" }),
    };
    const entries = transformEntries(
      ["rect-1", "rect-1", "missing", "rect-2"],
      translationMatrix(10, 0),
      0,
    );
    const changes = buildTransformEntryChanges(objects, entries, "page-1");
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ type: "mod-obj", "page-id": "page-1", id: "rect-1" });
    expect(changes[0].operations.map((operation) => operation.attr).sort()).toEqual([
      "points",
      "selrect",
      "x",
    ]);
    expect(changes[1].id).toBe("rect-2");
  });

  it("gives every entry its own matrix", () => {
    const objects: WorkspaceObjects = {
      "rect-1": rectShape(),
      "rect-2": rectShape({ id: "rect-2" }),
    };
    const entries: TransformEntry[] = [
      { id: "rect-1", matrix: translationMatrix(10, 0), rotation: 0 },
      { id: "rect-2", matrix: translationMatrix(0, 5), rotation: 0 },
    ];
    const byId = new Map(
      buildTransformEntryChanges(objects, entries, "page-1").map((change) => [change.id, change]),
    );
    const value = (id: string, attr: string): unknown =>
      byId.get(id)?.operations.find((operation) => operation.attr === attr)?.val;
    expect(value("rect-1", "x")).toBe(10);
    expect(value("rect-2", "y")).toBe(5);
    // Each entry wrote its own delta and only the attributes it changed.
    expect(value("rect-1", "y")).toBeUndefined();
    expect(value("rect-2", "x")).toBeUndefined();
  });

  it("sends nothing for an identity transform", () => {
    const objects: WorkspaceObjects = { "rect-1": rectShape() };
    const entries = transformEntries(["rect-1"], IDENTITY_MATRIX, 0);
    expect(buildTransformEntryChanges(objects, entries, "page-1")).toEqual([]);
    expect(transformShapePatch(rectShape(), IDENTITY_MATRIX, 0)).toEqual({});
  });

  it("carries the path content as one operation", () => {
    const content = new PathData(packedSegment(1, { 20: 1, 24: 2 }));
    const path = shape("path-1", "path", {
      selrect: { ...SELRECT },
      points: POINTS.map((point) => ({ ...point })),
      rotation: 0,
      transform: { ...IDENTITY_RECORD },
      "transform-inverse": { ...IDENTITY_RECORD },
      content,
    });
    const entries = transformEntries(["path-1"], translationMatrix(5, 5), 0);
    const changes = buildTransformEntryChanges({ "path-1": path }, entries, "page-1");
    expect(changes).toHaveLength(1);
    const attrs = changes[0].operations.map((operation) => operation.attr).sort();
    expect(attrs).toEqual(["content", "points", "selrect"]);
    const operation = changes[0].operations.find((entry) => entry.attr === "content");
    expect(operation?.val).toBeInstanceOf(PathData);
  });
});

describe("applyTransformEntries", () => {
  it("replaces only the transformed shapes and keeps the rest", () => {
    const objects: WorkspaceObjects = {
      "rect-1": rectShape(),
      "rect-2": rectShape({ id: "rect-2" }),
    };
    const entries = transformEntries(["rect-1"], translationMatrix(10, 0), 0);
    const next = applyTransformEntries(objects, entries);
    expect(next["rect-2"]).toBe(objects["rect-2"]);
    expect(next["rect-1"]).not.toBe(objects["rect-1"]);
    expect(next["rect-1"].x).toBe(10);
    expect(next["rect-1"].y).toBe(0);
  });

  it("keeps the first entry of an id", () => {
    const objects: WorkspaceObjects = { "rect-1": rectShape() };
    const entries: TransformEntry[] = [
      { id: "rect-1", matrix: translationMatrix(10, 0), rotation: 0 },
      { id: "rect-1", matrix: translationMatrix(0, 50), rotation: 0 },
    ];
    const next = applyTransformEntries(objects, entries);
    expect(next["rect-1"].x).toBe(10);
    expect(next["rect-1"].y).toBe(0);
  });
});
