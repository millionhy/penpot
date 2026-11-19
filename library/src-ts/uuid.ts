// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Port of `app.common.uuid_impl`: v8, time ordered identifiers with a
// 14 bit counter in the low part of the second word.

import type { Uuid } from "./model.ts";

const TIME_REF = 1640995200000; // ms since 2022-01-01T00:00:00Z
const MAX_COUNTER = 0x3fffn;
const BASE_MSB = 0x8000n;
const BASE_LSB = 0x8000_0000_0000_0000n;
const HEX = "0123456789abcdef";

export const ZERO: Uuid = "00000000-0000-0000-0000-000000000000";

const buffer = new ArrayBuffer(16);
const bytes = new Uint8Array(buffer);
const view = new DataView(buffer);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function randomUint64(): bigint {
  crypto.getRandomValues(bytes);
  return view.getBigUint64(0, false);
}

function currentTimestamp(): bigint {
  return BigInt.asUintN(64, BigInt(Date.now() - TIME_REF));
}

let lastRd = randomUint64() & 0xfffffffffffff0ffn;
let lastCs = randomUint64() & MAX_COUNTER;
let lastTs = 0n;
let countCs = 0n;

function format(msb: bigint, lsb: bigint): Uuid {
  view.setBigUint64(0, msb, false);
  view.setBigUint64(8, lsb, false);

  let result = "";
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) result += "-";
    result += HEX[bytes[i] >> 4] + HEX[bytes[i] & 0x0f];
  }
  return result;
}

export function next(): Uuid {
  for (;;) {
    const ts = currentTimestamp();

    // Protect from clock regression
    if (ts - lastTs < 0n) {
      lastRd = (lastRd & 0x0f00n) | (randomUint64() & 0xfffffffffffff0ffn);
      countCs = 0n;
      continue;
    }

    if (lastTs === ts) {
      if (countCs < MAX_COUNTER) {
        lastCs = (lastCs + 1n) & MAX_COUNTER;
        countCs++;
      } else {
        continue;
      }
    } else {
      lastTs = ts;
      lastCs = randomUint64() & MAX_COUNTER;
      countCs = 0n;
    }

    const msb = BASE_MSB | (lastRd & 0xffffffffffff0fffn);
    const lsb = BASE_LSB | ((ts << 14n) & 0x3fffffffffff_c000n) | lastCs;
    return format(msb, lsb);
  }
}

export function parse(value: unknown): Uuid | null {
  if (typeof value !== "string") return null;
  const normalized = value.toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

export function isValid(value: unknown): value is Uuid {
  return parse(value) != null;
}
