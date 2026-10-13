import { describe, expect, it } from "vitest";
import transit from "transit-js";
import { decodeTransit, encodeTransit, isPathData, PathData, resetTransitGuids } from "@/lib/transit";

// The fdata objects-map ("penpot/objects-map/v2",
// common/src/app/common/types/objects_map.cljc) arrives as a map of
// uuid -> transit-encoded shape STRING; the reader decodes every value
// eagerly into a plain objects map.
describe("decodeTransit objects-map", () => {
  const shapeString = '["~#shape",["^ ","~:id","s1","~:type","~:frame","~:name","Board"]]';

  function encodeObjectsMapDoc(): string {
    // Keyword keys make the writer emit the outer map the way the Clojure
    // backend does: the repeated "s1" key inside "again" becomes a cache
    // reference to the entry cached before the objects-map. The "aa"/"bb"
    // keys sit between the objects-map and that reference (see test 2).
    return encodeTransit(
      transit.map([
        transit.keyword("objects"),
        transit.tagged("penpot/objects-map/v2", transit.map([transit.keyword("s1"), shapeString])),
        transit.keyword("aa"),
        "1",
        transit.keyword("bb"),
        "2",
        transit.keyword("again"),
        transit.map([transit.keyword("s1"), "plain"]),
      ]),
    );
  }

  it("decodes the tagged objects-map into a plain uuid -> shape map", () => {
    const doc = encodeObjectsMapDoc();
    const result = decodeTransit<{
      objects: Record<string, { id: string; type: string; name: string }>;
    }>(doc);
    expect(Object.keys(result.objects)).toEqual(["s1"]);
    expect(result.objects.s1).toEqual({ id: "s1", type: "frame", name: "Board" });
  });

  it("never lets the nested shape decode clear the outer document cache", () => {
    const doc = encodeObjectsMapDoc();
    // The key "s1" repeats outside the objects-map, so the writer emits it as
    // a cache reference ("^N") to its earlier entry. A nested decode through
    // the outer reader would reset the outer cache pointer, letting "aa",
    // "bb" and "again" overwrite the referenced slot before it is read; those
    // three keys are long enough to be cached. The reference resolves only
    // with a fresh reader (t/decode-str builds one per call for the same
    // reason).
    expect(doc).toMatch(/,"\^\d/);
    const result = decodeTransit<{ again: Record<string, string> }>(doc);
    expect(result.again).toEqual({ s1: "plain" });
  });
});

// The penpot/path-data tagged value (app.common.types.path.impl) carries the
// packed segments of a path as transit binary ("~b", base64); the reader
// wraps the decoded bytes in PathData, whose segment layout, corrupted-slot
// skip and clamp bounds mirror read-segment / normalize-coord in the CLJS
// implementation.
describe("decodeTransit penpot/path-data", () => {
  const SEGMENT_BYTES = 28;

  // One writer per segment; each receives the DataView and its slot offset.
  // Coordinates land at fixed little-endian slots: +4 c1x, +8 c1y, +12 c2x,
  // +16 c2y, +20 x, +24 y; close-path carries none.
  function pathBytes(writers: Array<(view: DataView, offset: number) => void>): Uint8Array {
    const bytes = new Uint8Array(writers.length * SEGMENT_BYTES);
    const view = new DataView(bytes.buffer);
    writers.forEach((write, index) => write(view, index * SEGMENT_BYTES));
    return bytes;
  }

  function pathDoc(bytes: Uint8Array): string {
    return encodeTransit(transit.tagged("penpot/path-data", bytes));
  }

  function moveTo(view: DataView, offset: number, x: number, y: number): void {
    view.setInt16(offset, 1, true);
    view.setFloat32(offset + 20, x, true);
    view.setFloat32(offset + 24, y, true);
  }

  it("decodes the tagged binary into PathData segments", () => {
    const bytes = pathBytes([
      (view, offset) => moveTo(view, offset, 10, 20),
      (view, offset) => {
        view.setInt16(offset, 2, true);
        view.setFloat32(offset + 20, 30, true);
        view.setFloat32(offset + 24, 40, true);
      },
      (view, offset) => {
        view.setInt16(offset, 3, true);
        view.setFloat32(offset + 4, 1, true);
        view.setFloat32(offset + 8, 2, true);
        view.setFloat32(offset + 12, 3, true);
        view.setFloat32(offset + 16, 4, true);
        view.setFloat32(offset + 20, 5, true);
        view.setFloat32(offset + 24, 6, true);
      },
      (view, offset) => view.setInt16(offset, 4, true),
    ]);

    // The wire form the bundle carries: ["~#penpot/path-data","~b<base64>"].
    const doc = pathDoc(bytes);
    expect(doc).toMatch(/^\["~#penpot\/path-data","~b/);

    const result = decodeTransit(doc);
    expect(isPathData(result)).toBe(true);
    const path = result as PathData;
    expect(path.count).toBe(4);
    expect(path.toSegments()).toEqual([
      { command: "move-to", params: { x: 10, y: 20 } },
      { command: "line-to", params: { x: 30, y: 40 } },
      { command: "curve-to", params: { x: 5, y: 6, c1x: 1, c1y: 2, c2x: 3, c2y: 4 } },
      { command: "close-path", params: {} },
    ]);
    expect(path.toString()).toBe("M10,20L30,40C1,2,3,4,5,6Z");
  });

  it("skips corrupted segments but keeps counting them", () => {
    const bytes = pathBytes([
      (view, offset) => moveTo(view, offset, 1, 2),
      (view, offset) => view.setInt16(offset, 7, true),
      (view, offset) => {
        view.setInt16(offset, 2, true);
        view.setFloat32(offset + 20, 3, true);
        view.setFloat32(offset + 24, 4, true);
      },
    ]);
    const result = decodeTransit(pathDoc(bytes));
    expect(isPathData(result)).toBe(true);
    const path = result as PathData;
    // count is the raw slot count (the CLJS Counted returns size); only the
    // segment walks skip the unknown type.
    expect(path.count).toBe(3);
    expect(path.toSegments()).toEqual([
      { command: "move-to", params: { x: 1, y: 2 } },
      { command: "line-to", params: { x: 3, y: 4 } },
    ]);
    expect(path.toString()).toBe("M1,2L3,4");
  });

  it("clamps coordinates to the 32-bit safe bounds", () => {
    // ±1e12 are float32-representable but exceed sm/max-safe-int
    // (2147483647) and sm/min-safe-int (-2147483648).
    const bytes = pathBytes([(view, offset) => moveTo(view, offset, 1e12, -1e12)]);
    const result = decodeTransit(pathDoc(bytes));
    expect(isPathData(result)).toBe(true);
    expect((result as PathData).toSegments()).toEqual([
      { command: "move-to", params: { x: 2147483647, y: -2147483648 } },
    ]);
  });

  it("reads through a byteOffset view", () => {
    // A Uint8Array view can start at a non-zero byteOffset (Node Buffers
    // share a pool); the segment reads must honor it.
    const packed = pathBytes([(view, offset) => moveTo(view, offset, 7, 8)]);
    const padded = new Uint8Array(packed.byteLength + 8);
    padded.set(packed, 8);
    const path = new PathData(padded.subarray(8));
    expect(path.toSegments()).toEqual([{ command: "move-to", params: { x: 7, y: 8 } }]);
  });

  it("passes non-binary reps through untouched", () => {
    // Only Uint8Array reps become PathData; a text rep (older encodings)
    // decodes unchanged.
    const result = decodeTransit('["~#penpot/path-data","M0,0L1,1"]');
    expect(result).toBe("M0,0L1,1");
    expect(isPathData(result)).toBe(false);
  });
});

// The plugin sandbox repairs the JS intrinsics with SES and deletes every
// unrecognized own property of them, throwing when one resists deletion.
// The transit guid caches on Date and Uint8Array must therefore stay
// deletable, and the shared writer must be rebuilt after the sandbox import
// deleted the cache ids its handler table keys on (see the SES section in
// lib/transit). Freezing the constructors (hardenIntrinsics) is not
// exercised here: Object.freeze cannot be undone and the suite shares the
// realm.
describe("SES-compatible transit guids", () => {
  function guidNames(target: object): string[] {
    return Object.getOwnPropertyNames(target).filter((name) =>
      name.startsWith("transit$guid$"),
    );
  }

  it("stores the guid caches of Date and Uint8Array configurable", () => {
    for (const target of [Date, Uint8Array]) {
      const names = guidNames(target);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        expect(Object.getOwnPropertyDescriptor(target, name)?.configurable).toBe(true);
      }
    }
  });

  it("rebuilds the caches and the writer after the sandbox deleted them", () => {
    for (const target of [Date, Uint8Array]) {
      for (const name of guidNames(target)) Reflect.deleteProperty(target, name);
    }
    expect(guidNames(Date)).toEqual([]);

    resetTransitGuids();

    expect(guidNames(Date).length).toBeGreaterThan(0);
    expect(encodeTransit(new Date(86400000))).toBe("[\"~#'\",\"~m86400000\"]");
    expect(encodeTransit(new Uint8Array([1, 2, 3]))).toBe("[\"~#'\",\"~bAQID\"]");
  });
});
