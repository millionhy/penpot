// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

import assert from "node:assert/strict";
import test from "node:test";

import { ZERO, isValid, next, parse } from "../src-ts/uuid.ts";

test("generates v8 identifiers with the canonical layout", () => {
  const id = next();

  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(isValid(id), true);
});

test("identifiers grow inside the same millisecond", () => {
  const first = next();
  const second = next();

  assert.notEqual(first, second);
  assert.ok(second > first, `${second} should sort after ${first}`);
});

test("parse normalizes valid values and rejects the rest", () => {
  const id = next();

  assert.equal(parse(id.toUpperCase()), id);
  assert.equal(parse("not-a-uuid"), null);
  assert.equal(parse(42), null);
  assert.equal(parse(ZERO), ZERO);
});
