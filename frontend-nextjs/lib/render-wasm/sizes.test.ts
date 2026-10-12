import { describe, expect, it } from "vitest";

import { KEY, type RendererApp } from "@/lib/render-wasm/interop";
import { calculateSize } from "@/lib/render-wasm/sizes";

// sizes.ts talks to the compiled runtime through four helpers (keyword,
// persistent-array-map, get and one call target); this miniature runtime
// answers them the way the compiled exports do: interned keywords, maps as
// JS Map, and a PersistentArrayMap constructor that answers a Map.
type Kw = { readonly kw: string };

const keywords = new Map<string, Kw>();
function kw(name: string): Kw {
  let k = keywords.get(name);
  if (k === undefined) {
    k = { kw: name };
    keywords.set(name, k);
  }
  return k;
}

interface BoundsCall {
  objects: unknown;
  frame: unknown;
  options: unknown;
}

function makeApp(bounds: Map<unknown, unknown>, calls: BoundsCall[]): RendererApp {
  class MockPAM {
    // Same argument list as the compiled PersistentArrayMap constructor
    // (meta, cnt, arr, hash); only cnt and arr matter here.
    constructor(...args: unknown[]) {
      const cnt = args[1] as number;
      const arr = args[2] as unknown[];
      const m = new Map<unknown, unknown>();
      for (let i = 0; i + 1 < cnt; i += 2) m.set(arr[i], arr[i + 1]);
      return m as unknown as MockPAM;
    }
  }
  return {
    [KEY.keyword]: (name: unknown) => kw(String(name)),
    [KEY.get]: (coll: unknown, k: unknown) =>
      coll instanceof Map && coll.has(k) ? coll.get(k) : null,
    [KEY.persistentArrayMap]: MockPAM,
    [KEY.getObjectBounds]: (objects: unknown, frame: unknown, options: unknown) => {
      calls.push({ objects, frame, options });
      return bounds;
    },
  };
}

function boundsMap(entries: Record<string, unknown>): Map<unknown, unknown> {
  const m = new Map<unknown, unknown>();
  for (const [k, v] of Object.entries(entries)) m.set(kw(k), v);
  return m;
}

describe("calculateSize", () => {
  it("calls get-object-bounds with the frame and :ignore-margin? false", () => {
    const calls: BoundsCall[] = [];
    const objects = new Map([["uuid:frame-1", {}]]);
    const frame = { id: "uuid:frame-1" };
    const app = makeApp(boundsMap({ width: 100, height: 50, x: 10, y: 20 }), calls);

    const size = calculateSize(app, objects, frame, 2);

    // The option map is a runtime-built PersistentArrayMap (a Map here), so
    // the recorded call shows exactly what the compiled code would receive.
    expect(calls).toHaveLength(1);
    expect(calls[0].objects).toBe(objects);
    expect(calls[0].frame).toBe(frame);
    expect(calls[0].options).toEqual(new Map([[kw("ignore-margin?"), false]]));

    // The bounds carry the zoom while base-* stay zoom-free.
    expect(size).toEqual({
      baseWidth: 100,
      baseHeight: 50,
      x: 10,
      y: 20,
      width: 200,
      height: 100,
    });
  });

  it("rejects bounds whose width/height are not numbers", () => {
    const calls: BoundsCall[] = [];
    const app = makeApp(boundsMap({ x: 0, y: 0 }), calls);

    expect(() => calculateSize(app, new Map(), {}, 1)).toThrow(/width/);
  });
});
