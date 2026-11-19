// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

import assert from "node:assert/strict";
import test from "node:test";

import { createBuildContext } from "../src-ts/index.ts";

type Json = Record<string, any>;

type BoolType = "union" | "difference" | "intersection" | "exclude";

function page0(state: Json, pageId: string): Json {
  return state.files[state.currentFileId].data.pagesIndex[pageId];
}

function buildBool(type: BoolType): Json {
  const context = createBuildContext();
  context.addFile({ name: "file 1" });
  const pageId = context.addPage({ name: "page 1" });

  const groupId = context.addGroup({});
  context.addRect({ x: 0, y: 0, width: 100, height: 100 });
  context.addCircle({ x: 50, y: 50, width: 100, height: 100 });
  context.closeGroup();
  context.addBool({ groupId, type });

  const state = context.getInternalState() as Json;
  return page0(state, pageId).objects[groupId];
}

function box(shape: Json): Record<string, number> {
  return {
    x: shape.selrect.x,
    y: shape.selrect.y,
    width: shape.selrect.width,
    height: shape.selrect.height,
  };
}

// The expected paths come from the library 1.2.0-RC1 build of the
// reference implementation.
test("computes the union of a rect and a circle", () => {
  const shape = buildBool("union");

  assert.equal(shape.type, "bool");
  assert.equal(shape.boolType, "union");
  assert.equal(
    shape.content,
    "M50,100L0,100L0,0L100,0L100,50" +
      "C127.59574890136719,50,150,72.40425109863281,150,100" +
      "C150,127.59574890136719,127.59574890136719,150,100,150" +
      "C72.40425109863281,150,50,127.59574890136719,50,100",
  );
  assert.deepEqual(box(shape), { x: 0, y: 0, width: 150, height: 150 });
  assert.deepEqual(shape.points, [
    { x: 0, y: 0 },
    { x: 150, y: 0 },
    { x: 150, y: 150 },
    { x: 0, y: 150 },
  ]);
});

// The reference keeps two extra copies of a zero length curve here: its
// duplicate filter stores the segment tuples in a set with a tolerant
// comparator, and that order is not transitive, so a lookup misses. The
// dropped copies have no shape, the selrect and the points still match.
test("computes the difference of a rect and a circle", () => {
  const shape = buildBool("difference");

  assert.equal(shape.type, "bool");
  assert.equal(shape.boolType, "difference");
  assert.equal(
    shape.content,
    "M50,100L0,100L0,0L100,0L100,50" +
      "C72.40425109863281,50,50,72.40425109863281,50,100" +
      "C50,100,50,100,50,100" +
      "M100,50C100,50,100,50,100,50",
  );
  assert.deepEqual(box(shape), { x: 0, y: 0, width: 100, height: 100 });
});

test("computes the intersection of a rect and a circle", () => {
  const shape = buildBool("intersection");

  assert.equal(shape.type, "bool");
  assert.equal(shape.boolType, "intersection");
  assert.equal(
    shape.content,
    "M100,50L100,100L50,100L50,100" +
      "C50,72.40425109863281,72.40425109863281,50,100,50" +
      "M100,50C100,50,100,50,100,50",
  );
  assert.deepEqual(box(shape), { x: 50, y: 50, width: 50, height: 50 });
});

test("computes the exclusion of a rect and a circle", () => {
  const shape = buildBool("exclude");

  assert.equal(shape.type, "bool");
  assert.equal(shape.boolType, "exclude");
  assert.equal(
    shape.content,
    "M0,0L100,0L100,50L100,100L50,100L50,100L0,100L0,0" +
      "M100,50" +
      "C72.40425109863281,50,50,72.40425109863281,50,100" +
      "C50,127.59574890136719,72.40425109863281,150,100,150" +
      "C127.59574890136719,150,150,127.59574890136719,150,100" +
      "C150,72.40425109863281,127.59574890136719,50,100,50" +
      "C100,50,100,50,100,50",
  );
  assert.deepEqual(box(shape), { x: 0, y: 0, width: 150, height: 150 });
});

test("takes the fills from the head child and reports the group id", () => {
  const context = createBuildContext();
  context.addFile({ name: "file 1" });
  const pageId = context.addPage({ name: "page 1" });

  const groupId = context.addGroup({});
  context.addRect({
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    fills: [{ fillColor: "#FF0000", fillOpacity: 1 }],
  });
  context.addRect({
    x: 50,
    y: 50,
    width: 100,
    height: 100,
    fills: [{ fillColor: "#0000FF", fillOpacity: 1 }],
  });
  context.closeGroup();

  context.addBool({ groupId, type: "union" });
  assert.equal(context.lastId, groupId);

  const state = context.getInternalState() as Json;
  const shape = page0(state, pageId).objects[groupId];
  assert.deepEqual(shape.fills, [{ fillColor: "#0000FF", fillOpacity: 1 }]);
  assert.deepEqual(shape.strokes, []);
});

test("skips hidden children when it computes the content", () => {
  const context = createBuildContext();
  context.addFile({ name: "file 1" });
  const pageId = context.addPage({ name: "page 1" });

  const groupId = context.addGroup({});
  context.addRect({ x: 0, y: 0, width: 100, height: 100 });
  const circleId = context.addCircle({ x: 50, y: 50, width: 100, height: 100 });
  context.updateShape(circleId, (shape) => ({ ...shape, hidden: true }));
  context.closeGroup();
  context.addBool({ groupId, type: "union" });

  const state = context.getInternalState() as Json;
  const shape = page0(state, pageId).objects[groupId];
  assert.equal(shape.content, "M0,0L100,0L100,100L0,100L0,0");
  assert.deepEqual(box(shape), { x: 0, y: 0, width: 100, height: 100 });
});
