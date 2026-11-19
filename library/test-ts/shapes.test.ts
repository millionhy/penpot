// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

import assert from "node:assert/strict";
import test from "node:test";

import type { Shape } from "../src-ts/model.ts";
import { ZERO } from "../src-ts/uuid.ts";
import {
  assignShapeName,
  makeMinimalShape,
  setupShape,
} from "../src-ts/shapes.ts";

test("the minimal rect keeps the CLJS defaults", () => {
  const shape = makeMinimalShape("rect");

  assert.equal(shape.type, "rect");
  assert.equal(shape.name, "Rectangle");
  assert.equal(shape.x, 0);
  assert.equal(shape.y, 0);
  assert.equal(shape.width, 0.01);
  assert.equal(shape.height, 0.01);
  assert.equal(shape.rotation, 0);
  assert.equal(shape.parentId, ZERO);
  assert.equal(shape.frameId, ZERO);
  assert.equal(shape.flipX, null);
  assert.equal(shape.flipY, null);
  assert.deepEqual(shape.fills, [
    { fillColor: "#B1B2B5", fillOpacity: 1 },
  ]);
  assert.deepEqual(shape.strokes, []);
  assert.equal(shape.r1, 0);
  assert.equal(shape.r4, 0);
});

test("the minimal path and bool have no size", () => {
  for (const type of ["path", "bool"] as const) {
    const shape = makeMinimalShape(type);
    assert.equal(shape.x, null);
    assert.equal(shape.y, null);
    assert.equal(shape.width, null);
    assert.equal(shape.height, null);
  }
});

test("setupShape resolves the rect geometry", () => {
  const shape = setupShape({
    type: "rect",
    x: 10,
    y: 10,
    width: 20,
    height: 20,
  });

  assert.deepEqual(shape.selrect, {
    x: 10,
    y: 10,
    width: 20,
    height: 20,
    x1: 10,
    y1: 10,
    x2: 30,
    y2: 30,
  });
  assert.deepEqual(shape.points, [
    { x: 10, y: 10 },
    { x: 30, y: 10 },
    { x: 30, y: 30 },
    { x: 10, y: 30 },
  ]);
  assert.deepEqual(shape.transform, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  assert.equal(shape.proportion, 1);
  assert.equal(shape.proportionLock, false);
});

test("the circle keeps the Ellipse default name", () => {
  const shape = setupShape({ type: "circle", x: 1, y: 2, width: 3, height: 4 });

  assert.equal(shape.name, "Ellipse");
  assert.deepEqual(shape.fills, [
    { fillColor: "#B1B2B5", fillOpacity: 1 },
  ]);
});

test("the frame carries a white fill and an empty children list", () => {
  const shape = setupShape({
    type: "frame",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
  });

  assert.equal(shape.name, "Board");
  assert.deepEqual(shape.fills, [
    { fillColor: "#FFFFFF", fillOpacity: 1 },
  ]);
  assert.deepEqual(shape.shapes, []);
  assert.equal(shape.hideFillOnExport, false);
});

test("text keeps only the base attributes", () => {
  const shape = setupShape({
    type: "text",
    x: 5,
    y: 6,
    width: 30,
    height: 10,
  });

  assert.equal("fills" in shape, false);
  assert.equal("strokes" in shape, false);
  assert.equal("proportion" in shape, false);
});

test("setupShape derives the path selrect from its content", () => {
  const shape = setupShape({
    type: "path",
    content: [
      { command: "move-to", params: { x: 480, y: 839 } },
      { command: "line-to", params: { x: 439, y: 802 } },
      {
        command: "curve-to",
        params: { c1x: 368, c1y: 737, c2x: 310, c2y: 681, x: 264, y: 634 },
      },
      { command: "close-path", params: {} },
    ],
  });

  assert.equal(shape.x, null);
  assert.deepEqual(shape.selrect, {
    x: 264,
    y: 634,
    width: 216,
    height: 205,
    x1: 264,
    y1: 634,
    x2: 480,
    y2: 839,
  });
});

test("an empty path gets a zero selrect", () => {
  const shape = setupShape({ type: "path" });

  assert.deepEqual(shape.content, []);
  assert.deepEqual(shape.selrect, {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    x1: 0,
    y1: 0,
    x2: 0,
    y2: 0,
  });
});

test("paths accept an SVG string as content", () => {
  const shape = setupShape({
    type: "path",
    content: "M0,0 L10,0 Z",
  });

  assert.deepEqual(shape.content, [
    { command: "move-to", params: { x: 0, y: 0 } },
    { command: "line-to", params: { x: 10, y: 0 } },
    { command: "close-path", params: {} },
  ]);
});

test("image and svg-raw lock the proportion", () => {
  const image = setupShape({
    type: "image",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    metadata: { width: 200, height: 100 },
  });

  assert.equal(image.proportion, 2);
  assert.equal(image.proportionLock, true);

  const svg = setupShape({
    type: "svg-raw",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
  });

  assert.equal(svg.proportion, 2);
  assert.equal(svg.proportionLock, true);
});

test("assignShapeName dedups names per page", () => {
  const used = new Set<string>();

  const first = assignShapeName(
    { type: "group", name: null } as unknown as Shape,
    used,
  );
  used.add(first.name);

  const second = assignShapeName(
    { type: "group", name: null } as unknown as Shape,
    used,
  );

  assert.equal(first.name, "Group");
  assert.equal(second.name, "Group-1");
});

test("assignShapeName keeps explicit unique names", () => {
  const shape = assignShapeName(
    { type: "rect", name: "Header" } as unknown as Shape,
    new Set(["Rectangle"]),
  );

  assert.equal(shape.name, "Header");
});
