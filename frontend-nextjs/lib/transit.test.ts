import { describe, expect, it } from "vitest";
import transit from "transit-js";
import {
  decodeTransit,
  encodeTransit,
  encodeUpdateFile,
  isPathData,
  PathData,
  resetTransitGuids,
  type UpdateFileParams,
} from "@/lib/transit";

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

// The update-file write side (F9.3 AD6): the move commit pre-encodes its
// params through the writer — keyword keys, transit uuids, the
// penpot/path-data tagged binary — and the shared reader must decode that
// back into the JS shape it started from. The backend re-validates the
// same structure (schema:change / schema:operation of
// app.common.files.changes) AND the record tags: :selrect and every
// :points item decode through the "rect" / "point" handlers of
// app.common.geom.{rect,point}, whose instance checks a plain map fails
// (the T3 E2E hit "invalid shape found" until the tags were added).
describe("encodeUpdateFile", () => {
  const FILE_ID = "00000000-0000-0000-0000-0000000000f1";
  const SESSION_ID = "00000000-0000-0000-0000-0000000000f2";
  const PAGE_ID = "00000000-0000-0000-0000-0000000000f3";
  const SHAPE_ID = "00000000-0000-0000-0000-0000000000f4";

  // One translated move-to segment at x=13 y=13 (28 little-endian bytes).
  function packedMoveBytes(): Uint8Array {
    const bytes = new Uint8Array(28);
    const view = new DataView(bytes.buffer);
    view.setInt16(0, 1, true);
    view.setFloat32(20, 13, true);
    view.setFloat32(24, 13, true);
    return bytes;
  }

  function moveParams(content: PathData): UpdateFileParams {
    return {
      id: FILE_ID,
      "session-id": SESSION_ID,
      revn: 5,
      vern: 2,
      changes: [
        {
          type: "mod-obj",
          "page-id": PAGE_ID,
          id: SHAPE_ID,
          operations: [
            { type: "set", attr: "x", val: 13 },
            {
              type: "set",
              attr: "selrect",
              val: { x: 13, y: 13, width: 30, height: 40, x1: 13, y1: 13, x2: 43, y2: 53 },
            },
            {
              type: "set",
              attr: "points",
              val: [
                { x: 13, y: 13 },
                { x: 43, y: 13 },
                { x: 43, y: 53 },
                { x: 13, y: 53 },
              ],
            },
            { type: "set", attr: "content", val: content },
          ],
        },
      ],
    };
  }

  it("writes keyword keys, transit uuids and the tagged path binary", () => {
    const doc = encodeUpdateFile(moveParams(new PathData(packedMoveBytes())));
    expect(doc.startsWith('["^ "')).toBe(true);
    expect(doc).toContain('"~:id"');
    expect(doc).toContain(`"~u${FILE_ID}"`);
    expect(doc).toContain(`"~u${SESSION_ID}"`);
    expect(doc).toContain('"~:revn"');
    expect(doc).toContain('"~:vern"');
    expect(doc).toContain('"~:changes"');
    expect(doc).toContain('"~:mod-obj"');
    expect(doc).toContain('"~:page-id"');
    expect(doc).toContain('"~:operations"');
    expect(doc).toContain('"~:set"');
    expect(doc).toContain('"~:attr"');
    expect(doc).toContain('"~:selrect"');
    // The record tags the backend instance checks need: a plain map would
    // decode as a plain map and fail validation.
    expect(doc).toContain('"~#rect"');
    expect(doc).toContain('"~#point"');
    expect(doc).toMatch(/"~#rect",\["\^ "/);
    expect(doc).toContain('"~#penpot/path-data"');
  });

  it("round-trips through the reader into the original JS shape", () => {
    const doc = encodeUpdateFile(moveParams(new PathData(packedMoveBytes())));
    const decoded = decodeTransit<UpdateFileParams>(doc);
    expect(decoded).toEqual({
      id: FILE_ID,
      "session-id": SESSION_ID,
      revn: 5,
      vern: 2,
      changes: [
        {
          type: "mod-obj",
          "page-id": PAGE_ID,
          id: SHAPE_ID,
          operations: [
            { type: "set", attr: "x", val: 13 },
            {
              type: "set",
              attr: "selrect",
              val: { x: 13, y: 13, width: 30, height: 40, x1: 13, y1: 13, x2: 43, y2: 53 },
            },
            {
              type: "set",
              attr: "points",
              val: [
                { x: 13, y: 13 },
                { x: 43, y: 13 },
                { x: 43, y: 53 },
                { x: 13, y: 53 },
              ],
            },
            { type: "set", attr: "content", val: expect.any(PathData) },
          ],
        },
      ],
    });
    // The packed bytes survive the ~b base64 leg byte-for-byte.
    const change = decoded.changes[0];
    if (change.type !== "mod-obj") throw new Error("expected a mod-obj change");
    const contentOp = change.operations[3];
    expect(isPathData(contentOp.val)).toBe(true);
    expect(Array.from((contentOp.val as PathData).bytes)).toEqual(
      Array.from(packedMoveBytes()),
    );
  });

  it("writes a mov-objects change with uuid shapes and the zero root", () => {
    const root = "00000000-0000-0000-0000-000000000000";
    const params: UpdateFileParams = {
      id: FILE_ID,
      "session-id": SESSION_ID,
      revn: 6,
      vern: 2,
      changes: [
        {
          type: "mov-objects",
          "page-id": PAGE_ID,
          "parent-id": root,
          shapes: [SHAPE_ID, FILE_ID],
        },
      ],
    };
    const doc = encodeUpdateFile(params);
    expect(doc).toContain('"~:mov-objects"');
    expect(doc).toContain('"~:parent-id"');
    expect(doc).toContain('"~:shapes"');
    expect(doc).toContain(`"~u${root}"`);
    expect(doc).toContain(`"~u${SHAPE_ID}"`);
    expect(doc).toMatch(/"~:shapes",\["~u/);
    const decoded = decodeTransit<UpdateFileParams>(doc);
    expect(decoded).toEqual(params);
  });

  it("tags the uuid refs of a position-data op and keeps lookalikes plain", () => {
    const refFile = "11111111-2222-3333-4444-555555555555";
    const refId = "66666666-7777-8888-9999-000000000000";
    const imageId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    // A uuid-lookalike on a key outside the ref set: "font-id" names a font
    // (text-font-attrs) and the backend schema reads it as ::sm/text, so it
    // must stay a plain string.
    const lookalike = "12345678-1234-1234-1234-123456789012";
    const params: UpdateFileParams = {
      id: FILE_ID,
      "session-id": SESSION_ID,
      revn: 7,
      vern: 2,
      changes: [
        {
          type: "mod-obj",
          "page-id": PAGE_ID,
          id: SHAPE_ID,
          operations: [
            {
              type: "set",
              attr: "position-data",
              val: [
                {
                  x: 10,
                  y: 20,
                  width: 30,
                  height: 40,
                  text: "hello",
                  "font-id": lookalike,
                  fills: [
                    {
                      "fill-color": "#ff0000",
                      "fill-color-ref-id": refId,
                      "fill-color-ref-file": refFile,
                    },
                    {
                      "fill-image": {
                        width: 100,
                        height: 50,
                        mtype: "image/png",
                        id: imageId,
                        name: "bg",
                      },
                    },
                    { "fill-color-ref-file": null },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const doc = encodeUpdateFile(params);
    expect(doc).toContain(`"~u${refFile}"`);
    expect(doc).toContain(`"~u${refId}"`);
    expect(doc).toContain(`"~u${imageId}"`);
    // The tagged form carries the "~u" prefix, so a bare quoted uuid would be
    // the (invalid) plain-string encoding: none of them may appear.
    expect(doc).not.toContain(`"${refFile}"`);
    expect(doc).not.toContain(`"${refId}"`);
    expect(doc).not.toContain(`"${imageId}"`);
    expect(doc).toContain(`"${lookalike}"`);
    // The reader normalizes the tags back into the strings the model holds.
    const decoded = decodeTransit<UpdateFileParams>(doc);
    expect(decoded).toEqual(params);
  });
});
