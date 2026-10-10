import { describe, expect, it } from "vitest";
import transit from "transit-js";
import { decodeTransit, encodeTransit } from "@/lib/transit";

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
