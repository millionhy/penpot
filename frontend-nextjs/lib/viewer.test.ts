import { describe, expect, it } from "vitest";
import {
  ZERO_UUID,
  autoFrameIndex,
  buildViewerPages,
  canSelectNext,
  canSelectPrev,
  clampFrameIndex,
  decreaseZoom,
  fillZoom,
  fitZoom,
  formatPercent,
  frameIndexById,
  getParentIdsWithIndex,
  getViewerFrames,
  increaseZoom,
  initialViewerLocalState,
  isInteractionsMode,
  parseViewerQuery,
  resolveFileMedia,
  resolvePointerMap,
  resolveViewerFileData,
  shouldUpdateZoomQuery,
  showInteractionsFor,
  sortZIndexObjects,
  viewerHref,
  viewerQueryToHrefParams,
  type ViewerFileData,
  type ViewerFileSummary,
  type ViewerPage,
  type ViewerShape,
} from "@/lib/viewer";
import { Pointer } from "@/lib/transit";

function shape(overrides: Partial<ViewerShape> & { id: string }): ViewerShape {
  return { type: "frame", ...overrides };
}

// A page with two sibling frames on the page root plus one nested frame
// inside the first sibling, shaped like a real file's objects map.
function sampleObjects(): Record<string, ViewerShape> {
  return {
    [ZERO_UUID]: shape({ id: ZERO_UUID, shapes: ["f1", "f2"] }),
    f1: shape({ id: "f1", "parent-id": ZERO_UUID, name: "First", shapes: ["f11"] }),
    f2: shape({ id: "f2", "parent-id": ZERO_UUID, name: "Second" }),
    f11: shape({ id: "f11", "parent-id": "f1", name: "Nested" }),
    r1: { id: "r1", type: "rect", "parent-id": "f1" },
  };
}

describe("getParentIdsWithIndex", () => {
  it("walks up to the root collecting positions", () => {
    const objects = sampleObjects();
    const [parents, indices] = getParentIdsWithIndex(objects, "f11");
    expect(parents).toEqual(["f1", ZERO_UUID]);
    expect(indices["f1"]).toBe(0);
    expect(indices[ZERO_UUID]).toBe(0);
  });

  it("stops at shapes without a resolvable parent", () => {
    const objects = sampleObjects();
    const [parents] = getParentIdsWithIndex(objects, "f1");
    expect(parents).toEqual([ZERO_UUID]);
  });
});

describe("getViewerFrames", () => {
  it("collects only frame shapes and skips the root", () => {
    const frames = getViewerFrames(sampleObjects());
    expect(frames.map((f) => f.id).sort()).toEqual(["f1", "f11", "f2"]);
  });

  it("orders frames like the CLJS unstable-sort", () => {
    const frames = getViewerFrames(sampleObjects());
    // Among siblings the later shapes entry sorts first (f2 before f1);
    // a parent frame sorts before its nested frame (f1 before f11).
    expect(frames.map((f) => f.id)).toEqual(["f2", "f1", "f11"]);
  });

  it("drops hide-in-viewer frames unless allFrames is set", () => {
    const objects = sampleObjects();
    objects.f2["hide-in-viewer"] = true;
    expect(getViewerFrames(objects).map((f) => f.id)).toEqual(["f1", "f11"]);
    expect(getViewerFrames(objects, { allFrames: true }).map((f) => f.id).sort()).toEqual([
      "f1",
      "f11",
      "f2",
    ]);
  });

  it("sorts layout children by their layout-item-z-index", () => {
    const objects: Record<string, ViewerShape> = {
      [ZERO_UUID]: shape({ id: ZERO_UUID, shapes: ["lf"] }),
      lf: shape({ id: "lf", "parent-id": ZERO_UUID, layout: "flex", shapes: ["a", "b"] }),
      a: shape({ id: "a", "parent-id": "lf", "layout-item-z-index": 5 }),
      b: shape({ id: "b", "parent-id": "lf", "layout-item-z-index": 1 }),
    };
    // The CLJS `(< zA zB)` branch is false for 5 vs 1, so a sorts first.
    const frames = sortZIndexObjects(objects, [objects.a, objects.b]);
    expect(frames.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("breaks layout ties with the CLJS `>` index comparator", () => {
    const objects: Record<string, ViewerShape> = {
      [ZERO_UUID]: shape({ id: ZERO_UUID, shapes: ["lf"] }),
      lf: shape({ id: "lf", "parent-id": ZERO_UUID, layout: "flex", shapes: ["x", "y"] }),
      x: shape({ id: "x", "parent-id": "lf" }),
      y: shape({ id: "y", "parent-id": "lf" }),
    };
    // Equal z-index (0): the layout branch uses (> indexA indexB), so x
    // (index 0) sorts first, the opposite of plain siblings.
    const frames = sortZIndexObjects(objects, [objects.y, objects.x]);
    expect(frames.map((f) => f.id)).toEqual(["x", "y"]);
  });
});

describe("buildViewerPages", () => {
  it("derives frames and allFrames per page in file order", () => {
    const objects = sampleObjects();
    objects.f2["hide-in-viewer"] = true;
    const file: ViewerFileSummary = {
      id: "file-1",
      name: "File",
      data: {
        pages: ["p1"],
        "pages-index": { p1: { id: "p1", name: "Page 1", objects } },
      },
    };
    const pages = buildViewerPages(file);
    expect(Object.keys(pages)).toEqual(["p1"]);
    expect(pages.p1.frames.map((f) => f.id)).toEqual(["f1", "f11"]);
    expect(pages.p1.allFrames.map((f) => f.id).sort()).toEqual(["f1", "f11", "f2"]);
  });

  it("skips pages missing from the index", () => {
    const file: ViewerFileSummary = {
      id: "file-1",
      name: "File",
      data: { pages: ["p1", "gone"], "pages-index": { p1: { id: "p1", objects: {} } } },
    };
    expect(Object.keys(buildViewerPages(file))).toEqual(["p1"]);
  });
});

describe("resolvePointerMap", () => {
  it("replaces pointers through the fragment fetcher and keeps plain values", async () => {
    const calls: string[] = [];
    const fetchFragment = async (fragmentId: string): Promise<unknown> => {
      calls.push(fragmentId);
      return { resolved: fragmentId };
    };
    const out = await resolvePointerMap(
      { a: new Pointer("frag-1", null), b: { plain: true } },
      fetchFragment,
    );
    expect(out).toEqual({ a: { resolved: "frag-1" }, b: { plain: true } });
    expect(calls).toEqual(["frag-1"]);
  });
});

describe("resolveViewerFileData", () => {
  it("resolves pages-index first, then the top-level keys", async () => {
    const fragments: Record<string, unknown> = {
      pageFrag: { id: "p1", name: "Page 1", objects: {} },
      componentsFrag: { comp1: { id: "comp1" } },
    };
    const fetchFragment = async (fragmentId: string): Promise<unknown> => fragments[fragmentId];
    const fileData = {
      pages: ["p1"],
      "pages-index": { p1: new Pointer("pageFrag", null) },
      components: new Pointer("componentsFrag", null),
    } as unknown as ViewerFileData;

    const resolved = await resolveViewerFileData(fileData, fetchFragment);
    expect(resolved.pages).toEqual(["p1"]);
    expect(resolved["pages-index"].p1.name).toBe("Page 1");
    expect(resolved.components).toEqual({ comp1: { id: "comp1" } });
  });
});

describe("parseViewerQuery", () => {
  it("parses and validates the viewer URL parameters", () => {
    const search = new URLSearchParams({
      "file-id": "11111111-2222-3333-4444-555555555555",
      "page-id": "not-a-uuid",
      "share-id": "99999999-8888-7777-6666-555555555555",
      index: "3",
      "frame-id": "aaaabbbb-cccc-dddd-eeee-ffff00001111",
      zoom: "fit",
      "interactions-mode": "show",
    });
    const query = parseViewerQuery(search);
    expect(query.fileId).toBe("11111111-2222-3333-4444-555555555555");
    expect(query.pageId).toBeNull();
    expect(query.shareId).toBe("99999999-8888-7777-6666-555555555555");
    expect(query.index).toBe(3);
    expect(query.frameId).toBe("aaaabbbb-cccc-dddd-eeee-ffff00001111");
    expect(query.zoom).toBe("fit");
    expect(query.interactionsMode).toBe("show");
  });

  it("returns nulls for absent parameters", () => {
    const query = parseViewerQuery(new URLSearchParams());
    expect(query.fileId).toBeNull();
    expect(query.index).toBeNull();
    expect(query.frameId).toBeNull();
  });

  it("rejects non-integer indexes like parse-long", () => {
    expect(parseViewerQuery(new URLSearchParams({ index: "abc" })).index).toBeNull();
    expect(parseViewerQuery(new URLSearchParams({ index: "3.5" })).index).toBeNull();
    expect(parseViewerQuery(new URLSearchParams({ index: "" })).index).toBeNull();
    expect(parseViewerQuery(new URLSearchParams({ index: "-2" })).index).toBe(-2);
  });
});

describe("frame selection", () => {
  const page = {
    id: "p1",
    objects: sampleObjects(),
    frames: [shape({ id: "f1" }), shape({ id: "f2" })],
    allFrames: [shape({ id: "f1" }), shape({ id: "f2" })],
    options: { flows: [{ id: "flow-1", name: "Flow 1", "starting-frame": "f2" }] },
  } as unknown as ViewerPage;

  it("clamps the index into the frame list", () => {
    expect(clampFrameIndex(page.frames, 5)).toBe(1);
    // min/max pass negatives through untouched, like the CLJS.
    expect(clampFrameIndex(page.frames, -2)).toBe(-2);
    expect(clampFrameIndex(page.frames, null)).toBe(0);
    expect(clampFrameIndex([], 1)).toBe(0);
  });

  it("finds a frame index by id and falls back to 0", () => {
    expect(frameIndexById(page.frames, "f2")).toBe(1);
    expect(frameIndexById(page.frames, "missing")).toBe(0);
  });

  it("prefers the first flow's starting frame for auto navigation", () => {
    expect(autoFrameIndex(page)).toBe(1);
    const noFlows = { ...page, options: {} } as unknown as ViewerPage;
    expect(autoFrameIndex(noFlows)).toBe(0);
  });

  it("bounds prev/next navigation", () => {
    expect(canSelectPrev(0)).toBe(false);
    expect(canSelectPrev(1)).toBe(true);
    expect(canSelectNext(0, 2)).toBe(true);
    expect(canSelectNext(1, 2)).toBe(false);
  });
});

describe("zoom", () => {
  it("steps by 1.3 within bounds", () => {
    expect(increaseZoom(1)).toBeCloseTo(1.3);
    expect(increaseZoom(199)).toBe(200);
    expect(decreaseZoom(1.3)).toBeCloseTo(1);
    expect(decreaseZoom(0.01)).toBe(0.01);
  });

  it("fits and fills against the viewport", () => {
    const viewport = { width: 800, height: 600 };
    const rect = { width: 400, height: 400 };
    expect(fitZoom(viewport, rect)).toBe(1.5);
    expect(fillZoom(viewport, rect)).toBe(2);
  });

  it("only rewrites the zoom query when it disagrees", () => {
    expect(shouldUpdateZoomQuery(null, null)).toBe(false);
    expect(shouldUpdateZoomQuery("fit", "fit")).toBe(false);
    expect(shouldUpdateZoomQuery("fit", "fill")).toBe(true);
    expect(shouldUpdateZoomQuery(null, "fill")).toBe(true);
    expect(shouldUpdateZoomQuery("fit", null)).toBe(true);
  });
});

describe("interactions mode", () => {
  it("validates the mode names", () => {
    expect(isInteractionsMode("hide")).toBe(true);
    expect(isInteractionsMode("show")).toBe(true);
    expect(isInteractionsMode("show-on-click")).toBe(true);
    expect(isInteractionsMode("bogus")).toBe(false);
    expect(isInteractionsMode(null)).toBe(false);
  });

  it("maps the mode to the flash state", () => {
    expect(showInteractionsFor("show")).toBe(true);
    expect(showInteractionsFor("hide")).toBe(false);
    expect(showInteractionsFor("show-on-click")).toBe(false);
  });
});

describe("initialViewerLocalState", () => {
  it("matches the CLJS default-local-state", () => {
    const state = initialViewerLocalState("share-1");
    expect(state.zoom).toBe(1);
    expect(state.fullscreen).toBe(false);
    expect(state.interactionsMode).toBe("show-on-click");
    expect(state.showInteractions).toBe(false);
    expect(state.selected.size).toBe(0);
    expect(state.collapsed.size).toBe(0);
    expect(state.hover).toBeNull();
    expect(state.shareId).toBe("share-1");
  });
});

describe("resolveFileMedia", () => {
  it("prefers a data-uri over the stored blob", () => {
    expect(
      resolveFileMedia("", { id: "m1", "data-uri": "data:image/png;base64,x" }),
    ).toBe("data:image/png;base64,x");
  });

  it("builds by-file-media-id URLs, with the thumbnail variant", () => {
    expect(resolveFileMedia("", { id: "m1" })).toBe("/assets/by-file-media-id/m1");
    expect(resolveFileMedia("http://host/", { id: "m1" }, { thumbnail: true })).toBe(
      "http://host/assets/by-file-media-id/m1/thumbnail",
    );
  });

  it("appends the share id when the viewer runs on a share link", () => {
    expect(resolveFileMedia("", { id: "m1" }, { shareId: "s1" })).toBe(
      "/assets/by-file-media-id/m1?share-id=s1",
    );
  });
});

describe("formatPercent", () => {
  it("renders a fraction as a rounded percentage", () => {
    expect(formatPercent(0.5)).toBe("50%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(1 / 3)).toBe("33.33%");
  });

  it("honours the precision argument", () => {
    expect(formatPercent(1 / 3, 0)).toBe("33%");
    expect(formatPercent(1 / 3, 4)).toBe("33.3333%");
  });

  it("renders null for non-finite and missing values", () => {
    expect(formatPercent(Number.NaN)).toBeNull();
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBeNull();
    expect(formatPercent(null)).toBeNull();
    expect(formatPercent(undefined)).toBeNull();
  });
});

const FILE_ID = "11111111-1111-1111-1111-111111111111";
const PAGE_ID = "22222222-2222-2222-2222-222222222222";
const SHARE_ID = "33333333-3333-3333-3333-333333333333";
const FRAME_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("viewerHref", () => {
  it("serializes the viewer fields in the CLJS order", () => {
    expect(
      viewerHref({ fileId: FILE_ID, pageId: PAGE_ID, shareId: SHARE_ID, index: 0, section: "interactions" }),
    ).toBe(
      "/view?file-id=" + FILE_ID + "&page-id=" + PAGE_ID + "&share-id=" + SHARE_ID +
        "&index=0&section=interactions",
    );
  });

  it("drops null fields, down to a bare path for the file id alone", () => {
    expect(viewerHref({ fileId: FILE_ID, index: null, zoom: null })).toBe("/view?file-id=" + FILE_ID);
  });

  it("round-trips through parseViewerQuery", () => {
    const href = viewerHref({
      fileId: FILE_ID,
      pageId: PAGE_ID,
      shareId: SHARE_ID,
      index: 2,
      frameId: FRAME_ID,
      section: "interactions",
      zoom: "fit",
      interactionsMode: "show",
    });
    const query = parseViewerQuery(new URLSearchParams(href.split("?")[1]));
    expect(query.fileId).toBe(FILE_ID);
    expect(query.pageId).toBe(PAGE_ID);
    expect(query.shareId).toBe(SHARE_ID);
    expect(query.index).toBe(2);
    expect(query.frameId).toBe(FRAME_ID);
    expect(query.section).toBe("interactions");
    expect(query.zoom).toBe("fit");
    expect(query.interactionsMode).toBe("show");
  });
});

describe("viewerQueryToHrefParams", () => {
  it("copies every parsed field into the href shape", () => {
    const query = parseViewerQuery(
      new URLSearchParams({ "file-id": FILE_ID, "page-id": PAGE_ID, index: "1", zoom: "fill" }),
    );
    expect(viewerQueryToHrefParams(query)).toEqual({
      fileId: FILE_ID,
      pageId: PAGE_ID,
      shareId: null,
      index: 1,
      frameId: null,
      section: null,
      zoom: "fill",
      interactionsMode: null,
    });
  });

  it("returns null when the URL carries no file id", () => {
    expect(viewerQueryToHrefParams(parseViewerQuery(new URLSearchParams()))).toBeNull();
  });
});
