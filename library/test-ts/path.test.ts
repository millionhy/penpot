// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

import assert from "node:assert/strict";
import test from "node:test";

import type { PathSegment } from "../src-ts/model.ts";
import {
  calcSelrect,
  normalizeContent,
  parsePathString,
  serializePath,
} from "../src-ts/path.ts";

const SAMPLE: PathSegment[] = [
  { command: "move-to", params: { x: 480, y: 839 } },
  { command: "line-to", params: { x: 439, y: 802 } },
  {
    command: "curve-to",
    params: { c1x: 368, c1y: 737, c2x: 310, c2y: 681, x: 264, y: 634 },
  },
  { command: "close-path", params: {} },
];

test("serializes the same string the CLJS PathData produced", () => {
  assert.equal(
    serializePath(normalizeContent(SAMPLE)),
    "M480,839L439,802C368,737,310,681,264,634Z",
  );
});

test("computes the selrect of the sample path", () => {
  const selrect = calcSelrect(normalizeContent(SAMPLE));

  assert.deepEqual(
    { x: selrect.x, y: selrect.y, width: selrect.width, height: selrect.height },
    { x: 264, y: 634, width: 216, height: 205 },
  );
});

test("uses the exact cubic extrema for the bounding box", () => {
  const content: PathSegment[] = [
    { command: "move-to", params: { x: 0, y: 0 } },
    {
      command: "curve-to",
      params: { c1x: 100, c1y: -100, c2x: 200, c2y: -100, x: 300, y: 0 },
    },
  ];

  const selrect = calcSelrect(content);

  assert.deepEqual(
    { x: selrect.x, y: selrect.y, width: selrect.width, height: selrect.height },
    { x: 0, y: -75, width: 300, height: 75 },
  );
});

test("parses absolute and relative SVG commands", () => {
  assert.deepEqual(parsePathString("M0,0 L10,0 Z"), [
    { command: "move-to", params: { x: 0, y: 0 } },
    { command: "line-to", params: { x: 10, y: 0 } },
    { command: "close-path", params: {} },
  ]);

  assert.deepEqual(parsePathString("M10,10 h5 v5 h-5 z"), [
    { command: "move-to", params: { x: 10, y: 10 } },
    { command: "line-to", params: { x: 15, y: 10 } },
    { command: "line-to", params: { x: 15, y: 15 } },
    { command: "line-to", params: { x: 10, y: 15 } },
    { command: "close-path", params: {} },
  ]);
});

test("elevates quadratic curves to cubic ones", () => {
  const [move, curve] = parsePathString("M0,0 Q50,100 100,0");

  assert.deepEqual(move, { command: "move-to", params: { x: 0, y: 0 } });
  assert.deepEqual(curve, {
    command: "curve-to",
    params: {
      x: 100,
      y: 0,
      c1x: Math.fround(100 / 3),
      c1y: Math.fround(200 / 3),
      c2x: Math.fround(200 / 3),
      c2y: Math.fround(200 / 3),
    },
  });
});

test("quantizes coordinates to float32 like the path data", () => {
  const content = normalizeContent([
    { command: "move-to", params: { x: 0.1, y: 0 } },
  ]);

  assert.equal(content[0].params.x, Math.fround(0.1));
});
