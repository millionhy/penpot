import { describe, expect, it } from "vitest";
import { KEY, arrayMap, type RendererApp } from "@/lib/render-wasm/interop";

// arrayMap builds a CLJS PersistentArrayMap through the compiled
// constructor. The fake records the exact arguments, which is the contract
// the runtime asserts: cnt counts entries, arr holds two slots per entry.
interface PAMCall {
  meta: unknown;
  cnt: number;
  arr: unknown[];
  hash: unknown;
}

function makeApp(calls: PAMCall[]): RendererApp {
  class FakePAM {
    constructor(meta: unknown, cnt: number, arr: unknown[], hash: unknown) {
      calls.push({ meta, cnt, arr, hash });
    }
  }
  return { [KEY.persistentArrayMap]: FakePAM };
}

describe("arrayMap", () => {
  it("passes the entry count and the flattened key/value array", () => {
    const calls: PAMCall[] = [];
    const app = makeApp(calls);
    const key = { kw: "ignore-margin?" };

    arrayMap(app, [[key, false]]);

    expect(calls).toHaveLength(1);
    expect(calls[0].cnt).toBe(1);
    expect(calls[0].arr).toEqual([key, false]);
  });

  it("counts two entries for a two-key map", () => {
    const calls: PAMCall[] = [];
    const app = makeApp(calls);
    const a = { kw: "a" };
    const b = { kw: "b" };

    arrayMap(app, [
      [a, 1],
      [b, 2],
    ]);

    expect(calls[0].cnt).toBe(2);
    expect(calls[0].arr).toEqual([a, 1, b, 2]);
  });

  it("builds the empty map with a zero count", () => {
    const calls: PAMCall[] = [];
    const app = makeApp(calls);

    arrayMap(app, []);

    expect(calls[0].cnt).toBe(0);
    expect(calls[0].arr).toEqual([]);
  });
});
