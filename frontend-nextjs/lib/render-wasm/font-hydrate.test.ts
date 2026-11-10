import { describe, expect, it } from "vitest";

import { KEY } from "./interop";
import { hydrateTextFonts } from "./font-hydrate";
import type { FontFaceRef } from "./fonts";

// A content tree with one text node carrying the given font attrs (the shape
// lib/workspace-text.ts createTextContent produces, hand-built to stay free of
// the model layer here).
function textContent(fontAttrs: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "root",
    children: [
      {
        type: "paragraph-set",
        children: [
          {
            type: "paragraph",
            children: [{ text: "hello", ...fontAttrs }],
          },
        ],
      },
    ],
  };
}

interface FakeEngine {
  readonly app: Record<string, unknown>;
  readonly stored: string[];
  readonly fetched: string[];
  readonly layouts: string[];
  uploadedKeys: Set<string>;
}

// A fake app + module: _is_font_uploaded reads the set the _store_font writes
// populate, so the dedup/skip logic is exercised end to end.
function fakeEngine(live = true): FakeEngine {
  const stored: string[] = [];
  const fetched: string[] = [];
  const layouts: string[] = [];
  const uploadedKeys = new Set<string>();
  const buffer = new ArrayBuffer(4096);
  const heap = new Uint8Array(buffer);
  let lastSize = 0;

  const faceKeyFromArgs = (a: number, _b: number, _c: number, _d: number, w: number, s: number) =>
    `${a}:${w}:${s}`;

  const mod = {
    HEAPU8: heap,
    _alloc_bytes(len: number) {
      lastSize = len;
      return 0;
    },
    _store_font(a: number, b: number, c: number, d: number, w: number, s: number) {
      stored.push(faceKeyFromArgs(a, b, c, d, w, s));
      uploadedKeys.add(faceKeyFromArgs(a, b, c, d, w, s));
    },
    _store_font_url() {
      /* url bookkeeping is irrelevant to the hydrate contract */
    },
    _is_font_uploaded(a: number, _b: number, _c: number, _d: number, w: number, s: number) {
      return uploadedKeys.has(faceKeyFromArgs(a, 0, 0, 0, w, s)) ? 1 : 0;
    },
    _force_update_shape_text_layout_for(a: number, b: number, c: number, d: number) {
      layouts.push(`${a}-${b}-${c}-${d}`);
    },
    _update_shape_text_layout_for() {
      /* not used by hydrate */
    },
  };

  return {
    app: { [KEY.wasmLive]: () => live, [KEY.internalModule]: mod } as Record<string, unknown>,
    stored,
    fetched,
    layouts,
    uploadedKeys,
  };
}

const fetchBytes = (engine: FakeEngine, bytes = new Uint8Array([1, 2, 3]).buffer) =>
  (url: string): Promise<ArrayBuffer> => {
    engine.fetched.push(url);
    return Promise.resolve(bytes);
  };

describe("hydrateTextFonts", () => {
  it("fetches and stores a builtin face, then re-runs the shape layout", async () => {
    const engine = fakeEngine();
    const shapes = [{ id: "shape-a", type: "text", content: textContent({ "font-id": "sourcesanspro" }) }];

    await hydrateTextFonts(engine.app, shapes, {
      publicUri: "",
      fetchBytes: fetchBytes(engine),
    });

    expect(engine.fetched).toEqual(["/fonts/sourcesanspro-regular.ttf"]);
    expect(engine.stored).toEqual(["0:400:0"]);
    expect(engine.layouts).toHaveLength(1);
  });

  it("skips the fetch when the engine already holds the face, but still relayouts", async () => {
    const engine = fakeEngine();
    const shapes = [{ id: "shape-a", type: "text", content: textContent({ "font-id": "sourcesanspro" }) }];

    // First pass stores it.
    await hydrateTextFonts(engine.app, shapes, { publicUri: "", fetchBytes: fetchBytes(engine) });
    const fetchesAfterFirst = engine.fetched.length;

    // Second pass: bytes present, no new fetch, layout still re-run.
    await hydrateTextFonts(engine.app, shapes, { publicUri: "", fetchBytes: fetchBytes(engine) });

    expect(engine.fetched).toHaveLength(fetchesAfterFirst);
    expect(engine.layouts).toHaveLength(2);
  });

  it("dedupes a face shared by two shapes into one fetch, two relayouts", async () => {
    const engine = fakeEngine();
    const shapes = [
      { id: "shape-a", type: "text", content: textContent({ "font-id": "sourcesanspro" }) },
      { id: "shape-b", type: "text", content: textContent({ "font-id": "sourcesanspro" }) },
    ];

    await hydrateTextFonts(engine.app, shapes, { publicUri: "", fetchBytes: fetchBytes(engine) });

    expect(engine.fetched).toHaveLength(1);
    expect(engine.stored).toHaveLength(1);
    expect(engine.layouts).toHaveLength(2);
  });

  it("ignores non-text shapes", async () => {
    const engine = fakeEngine();
    await hydrateTextFonts(
      engine.app,
      [{ id: "rect-1", type: "rect", content: textContent({}) }],
      { publicUri: "", fetchBytes: fetchBytes(engine) },
    );
    expect(engine.fetched).toHaveLength(0);
    expect(engine.layouts).toHaveLength(0);
  });

  it("degrades a google face without fetching", async () => {
    const engine = fakeEngine();
    await hydrateTextFonts(
      engine.app,
      [{ id: "text-1", type: "text", content: textContent({ "font-id": "gfont-noto-sans" }) }],
      { publicUri: "", fetchBytes: fetchBytes(engine) },
    );
    expect(engine.fetched).toHaveLength(0);
    // Layout still re-runs (the shape is present; the face simply stays blank).
    expect(engine.layouts).toHaveLength(1);
  });

  it("degrades a custom face when no variant row is injected", async () => {
    const engine = fakeEngine();
    await hydrateTextFonts(
      engine.app,
      [{ id: "text-1", type: "text", content: textContent({ "font-id": "custom-ad9d5693-49bf-81be-8008-dde80b1438d6" }) }],
      { publicUri: "", fetchBytes: fetchBytes(engine) },
    );
    expect(engine.fetched).toHaveLength(0);
  });

  it("stores a custom face when the registry row resolves", async () => {
    const engine = fakeEngine();
    const ref: FontFaceRef = { fontId: "custom-ad9d5693-49bf-81be-8008-dde80b1438d6" };
    await hydrateTextFonts(
      engine.app,
      [{ id: "text-1", type: "text", content: textContent({ "font-id": ref.fontId }) }],
      {
        publicUri: "",
        fetchBytes: fetchBytes(engine),
        getCustomVariant: () => ({ weight: 400, style: "normal", ttfFileId: "file-9" }),
      },
    );
    expect(engine.fetched).toEqual(["/assets/by-id/file-9"]);
    expect(engine.stored).toHaveLength(1);
  });

  it("stops before storing when the mount guard goes false during the fetch", async () => {
    const engine = fakeEngine();
    let alive = true;
    const slowFetch = (_url: string): Promise<ArrayBuffer> => {
      alive = false; // the canvas unmounts while the bytes are in flight
      return Promise.resolve(new Uint8Array([1]).buffer);
    };
    await hydrateTextFonts(
      engine.app,
      [{ id: "text-1", type: "text", content: textContent({ "font-id": "sourcesanspro" }) }],
      { publicUri: "", fetchBytes: slowFetch, isAlive: () => alive },
    );
    expect(engine.stored).toHaveLength(0);
    expect(engine.layouts).toHaveLength(0);
  });

  it("reports a fetch failure without throwing", async () => {
    const engine = fakeEngine();
    const errors: unknown[] = [];
    await hydrateTextFonts(
      engine.app,
      [{ id: "text-1", type: "text", content: textContent({ "font-id": "sourcesanspro" }) }],
      {
        publicUri: "",
        fetchBytes: () => Promise.reject(new Error("offline")),
        onError: (cause) => errors.push(cause),
      },
    );
    expect(errors).toHaveLength(1);
    // The face never landed, so no store; layout still re-runs for the shape.
    expect(engine.stored).toHaveLength(0);
    expect(engine.layouts).toHaveLength(1);
  });
});
