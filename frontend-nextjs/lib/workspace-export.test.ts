// The server shape export of lib/workspace-export.ts: the entries built from
// the panel specs, the wire body the exporter's POST /api/export expects, and
// the request itself (URL, method, transit payload, download).

import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeParams, encodeTransit } from "@/lib/transit";
import {
  buildExportEntries,
  exportParams,
  exportResourceName,
  exportShapes,
  exportWireBody,
} from "@/lib/workspace-export";
import type { ShapeExports } from "@/lib/workspace-export";

function shape(
  id: string,
  name: string | undefined,
  specs: ShapeExports["specs"],
): ShapeExports {
  return { shape: { id, name }, specs };
}

describe("buildExportEntries", () => {
  it("makes one entry per spec, in panel order", () => {
    const entries = buildExportEntries("file-1", "page-1", [
      shape("a", "Rect", [
        { type: "png", scale: 2, suffix: "@2x" },
        { type: "svg", scale: 1, suffix: "" },
      ]),
    ]);
    expect(entries).toEqual([
      {
        fileId: "file-1",
        pageId: "page-1",
        objectId: "a",
        type: "png",
        scale: 2,
        suffix: "@2x",
        name: "Rect",
      },
      {
        fileId: "file-1",
        pageId: "page-1",
        objectId: "a",
        type: "svg",
        scale: 1,
        suffix: "",
        name: "Rect",
      },
    ]);
  });

  it("keeps the shape order of a multi selection", () => {
    const entries = buildExportEntries("f", "p", [
      shape("a", "A", [{ type: "png", scale: 1, suffix: "" }]),
      shape("b", "B", [{ type: "png", scale: 1, suffix: "" }]),
    ]);
    expect(entries.map((entry) => entry.objectId)).toEqual(["a", "b"]);
  });

  it("skips a shape without specs", () => {
    const entries = buildExportEntries("f", "p", [
      shape("a", "A", []),
      shape("b", "B", [{ type: "pdf", scale: 1, suffix: "" }]),
    ]);
    expect(entries.map((entry) => entry.objectId)).toEqual(["b"]);
  });

  it("falls back to the id for a blank name (normalize-export)", () => {
    const entries = buildExportEntries("f", "p", [
      shape("a", "   ", [{ type: "png", scale: 1, suffix: "" }]),
      shape("b", undefined, [{ type: "png", scale: 1, suffix: "" }]),
    ]);
    expect(entries.map((entry) => entry.name)).toEqual(["a", "b"]);
  });
});

describe("exportResourceName", () => {
  it("uses the first shape name", () => {
    const items = [
      shape("a", "First", [{ type: "png", scale: 1, suffix: "" }]),
      shape("b", "Second", [{ type: "png", scale: 1, suffix: "" }]),
    ];
    expect(exportResourceName(items, buildExportEntries("f", "p", items))).toBe("First");
  });

  it("falls back to the object id and then to a literal", () => {
    const items = [shape("a", "", [])];
    expect(exportResourceName(items, [])).toBe("a");
    expect(exportResourceName([], [])).toBe("export");
  });
});

describe("exportParams / exportWireBody", () => {
  const items = [
    shape("a", "Rect", [{ type: "png", scale: 2, suffix: "@2x" }]),
  ];
  const entries = buildExportEntries("file-1", "page-1", items);

  it("waits for the resource and takes the server branch", () => {
    const params = exportParams(entries, "Rect", "profile-1");
    expect(params.cmd).toBe("export-shapes");
    expect(params.wait).toBe(true);
    expect(params["is-wasm"]).toBe(true);
    expect(params["profile-id"]).toBe("profile-1");
    expect(params.exports).toHaveLength(1);
  });

  it("carries the suffix once, never pre-appended to the name", () => {
    // The exporter builds :name + :suffix + extension; the CLJS sidebar
    // appends the suffix to the name as well and gets it twice.
    const params = exportParams(entries, "Rect", "profile-1");
    expect(params.exports[0].name).toBe("Rect");
    expect(params.exports[0].suffix).toBe("@2x");
  });

  it("encodes the command, the entry keys and its type as keywords", () => {
    const body = exportWireBody(exportParams(entries, "Rect", "profile-1"));
    expect(body.cmd).toBeDefined();
    expect(Array.isArray(body.exports)).toBe(true);
    // postTransit keywordizes the top-level keys (encodeParams); the nested
    // entries arrive keywordized from exportWireBody.
    const wire = encodeParams(body);
    expect(wire).toContain("~:export-shapes");
    expect(wire).toContain("~:profile-id");
    expect(wire).toContain("~:file-id");
    expect(wire).toContain("~:page-id");
    expect(wire).toContain("~:object-id");
    expect(wire).toContain("~:png");
    // Plain strings stay strings: the exporter reads :name and :suffix as such.
    expect(wire).toContain('"Rect"');
    expect(wire).toContain('"@2x"');
  });
});

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(body: string): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/transit+json" },
    });
  });
  return calls;
}

// triggerDownloadUri (lib/dom.ts) builds an anchor and clicks it; node has no
// document, so the stub records the download name instead.
function stubDocument(): string[] {
  const clicks: string[] = [];
  vi.stubGlobal("document", {
    createElement: () => {
      const link = {
        href: "",
        download: "",
        style: {} as Record<string, string>,
        click(): void {
          clicks.push(link.download);
        },
        remove(): void {},
      };
      return link;
    },
    body: { appendChild: (): void => {} },
  });
  return clicks;
}

describe("exportShapes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the transit body to api/export and downloads the resource", async () => {
    const calls = stubFetch(
      encodeTransit({
        filename: "Rect@2x.png",
        mtype: "image/png",
        uri: "http://localhost:6060/assets/tmp/rect.png",
      }),
    );
    const clicks = stubDocument();

    const resource = await exportShapes({
      fileId: "file-1",
      pageId: "page-1",
      profileId: "profile-1",
      items: [shape("a", "Rect", [{ type: "png", scale: 2, suffix: "@2x" }])],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/export");
    expect(calls[0].init.method).toBe("POST");
    expect(new Headers(calls[0].init.headers).get("content-type")).toBe(
      "application/transit+json",
    );
    expect(String(calls[0].init.body)).toContain("~:export-shapes");
    expect(String(calls[0].init.body)).toContain("~:profile-id");

    expect(resource).toEqual({
      filename: "Rect@2x.png",
      mtype: "image/png",
      uri: "http://localhost:6060/assets/tmp/rect.png",
    });
    expect(clicks).toEqual(["Rect@2x.png"]);
  });

  it("sends nothing when no shape carries a spec", async () => {
    const calls = stubFetch(encodeTransit({}));

    const resource = await exportShapes({
      fileId: "f",
      pageId: "p",
      profileId: "profile-1",
      items: [shape("a", "Rect", [])],
    });

    expect(resource).toBeNull();
    expect(calls).toHaveLength(0);
  });
});