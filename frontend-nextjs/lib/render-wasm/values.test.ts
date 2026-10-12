import { afterEach, describe, expect, it, vi } from "vitest";
import { KEY, get, keyword, type RendererApp } from "@/lib/render-wasm/interop";
import {
  decodeBundleText,
  fetchBundleText,
  fetchDecodedBundle,
  loadDecodedBundle,
  resolveBundlePointers,
} from "@/lib/render-wasm/values";

// A miniature CLJS runtime behind the $APP keys values.ts calls, enough to
// run the bridge end to end: interning keywords, uuids as plain marker
// strings, maps as JS Map, a PersistentArrayMap constructor that answers a
// Map (the compiled one is associative the same way), and seq/first/next/val
// over an entries array.
type Kw = { readonly kw: string };
type Pointer = { readonly pointerId: string };

const keywords = new Map<string, Kw>();
function kw(name: string): Kw {
  let k = keywords.get(name);
  if (k === undefined) {
    k = { kw: name };
    keywords.set(name, k);
  }
  return k;
}

// Test data carries CLJS values as marker strings in JSON:
// "~kw:x" -> keyword x, "~uuid:x" -> the uuid the mock uuid parse answers,
// "~ptr:x" -> a transit pointer whose deref is x.
function revive(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("~kw:")) return kw(value.slice(4));
    if (value.startsWith("~uuid:")) return value.slice(1);
    if (value.startsWith("~ptr:")) return { pointerId: value.slice(5) };
    return value;
  }
  if (Array.isArray(value)) return value.map(revive);
  if (value !== null && typeof value === "object") {
    const m = new Map<unknown, unknown>();
    for (const [k, v] of Object.entries(value)) m.set(revive(k), revive(v));
    return m;
  }
  return value;
}

function makeApp(): RendererApp {
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
  const app: RendererApp = {
    [KEY.decodeStr]: (raw: unknown) => revive(JSON.parse(String(raw))),
    [KEY.keyword]: (name: unknown) => kw(String(name)),
    [KEY.uuidParse]: (id: unknown) => `uuid:${String(id)}`,
    [KEY.get]: (coll: unknown, k: unknown) =>
      coll instanceof Map && coll.has(k) ? coll.get(k) : null,
    [KEY.assoc]: (coll: unknown, k: unknown, v: unknown) => {
      const m = new Map(coll instanceof Map ? coll : undefined);
      m.set(k, v);
      return m;
    },
    [KEY.seq]: (coll: unknown) =>
      coll instanceof Map && coll.size > 0 ? Array.from(coll.entries()) : null,
    [KEY.first]: (s: unknown) => (Array.isArray(s) && s.length > 0 ? s[0] : null),
    [KEY.next]: (s: unknown) => (Array.isArray(s) && s.length > 1 ? s.slice(1) : null),
    [KEY.val]: (entry: unknown) => (Array.isArray(entry) ? entry[1] : null),
    [KEY.str]: (v: unknown) => String(v),
    [KEY.deref]: (p: unknown) => (p as Pointer).pointerId,
    [KEY.pointerQmark]: (v: unknown) =>
      typeof v === "object" && v !== null && "pointerId" in v,
    [KEY.persistentArrayMap]: MockPAM,
  };
  return app;
}

const bundle = {
  "~kw:file": {
    "~kw:data": {
      "~kw:pages-index": {
        "~uuid:p1": "~ptr:page-frag",
      },
      "~kw:media": "~ptr:media-frag",
    },
  },
};
const bundleText = JSON.stringify(bundle);

const fragments: Record<string, unknown> = {
  "page-frag": { "~kw:data": { "~kw:objects": { "~uuid:frame-1": {} } } },
  "media-frag": { "~kw:data": { "~kw:images": { "~uuid:img-1": {} } } },
};

// Routes the two RPC commands of the bridge; records every URL.
function stubFetch(seen: string[], bundleBody: string = bundleText): void {
  vi.stubGlobal("fetch", async (url: string | URL | Request) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("get-view-only-bundle")) {
      return new Response(bundleBody, {
        status: 200,
        headers: { "content-type": "application/transit+json" },
      });
    }
    if (u.includes("get-file-fragment")) {
      const id = new URL(u, "http://localhost").searchParams.get("fragment-id") ?? "";
      const frag = fragments[id];
      if (frag === undefined) return new Response("missing", { status: 404 });
      return new Response(JSON.stringify(frag), {
        status: 200,
        headers: { "content-type": "application/transit+json" },
      });
    }
    return new Response("unexpected", { status: 500 });
  });
}

function getKey(app: RendererApp, coll: unknown, name: string): unknown {
  return get(app, coll, keyword(app, name));
}

describe("values", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("unwraps :file and :data with the compiled decoder", () => {
    const app = makeApp();
    const decoded = decodeBundleText(app, bundleText);

    expect(getKey(app, decoded.file, "data")).toBe(decoded.fileData);
    expect(getKey(app, decoded.fileData, "pages-index")).toBeInstanceOf(Map);
  });

  it("hands the bundle text back untouched (no transit decode)", async () => {
    const seen: string[] = [];
    stubFetch(seen);

    expect(await fetchBundleText({ fileId: "f1" })).toBe(bundleText);
    expect(seen[0]).toContain("get-view-only-bundle");
  });

  it("resolves both pointer passes through get-file-fragment", async () => {
    const seen: string[] = [];
    stubFetch(seen);
    const app = makeApp();

    // The call sequence page.tsx runs: raw text, decode, pointer resolution.
    const raw = await fetchBundleText({ fileId: "f1", shareId: "s1" });
    const decoded = decodeBundleText(app, raw);
    const fileData = await resolveBundlePointers(app, decoded.fileData, {
      fileId: "f1",
      shareId: "s1",
    });

    const pagesIndex = getKey(app, fileData, "pages-index");
    expect(pagesIndex).toEqual(new Map([["uuid:p1", new Map([[kw("objects"), new Map([["uuid:frame-1", new Map()]])]])]]));
    expect(getKey(app, fileData, "media")).toEqual(
      new Map([[kw("images"), new Map([["uuid:img-1", new Map()]])]]),
    );

    const bundleParams = new URL(seen[0], "http://localhost").searchParams;
    expect(bundleParams.get("file-id")).toBe("f1");
    expect(bundleParams.get("share-id")).toBe("s1");
    expect(bundleParams.getAll("features").length).toBeGreaterThan(0);

    const fragmentUrls = seen.filter((u) => u.includes("get-file-fragment"));
    expect(fragmentUrls).toHaveLength(2);
    for (const u of fragmentUrls) {
      const params = new URL(u, "http://localhost").searchParams;
      expect(params.get("file-id")).toBe("f1");
      expect(params.get("share-id")).toBe("s1");
    }
    expect(
      fragmentUrls
        .map((u) => new URL(u, "http://localhost").searchParams.get("fragment-id"))
        .sort(),
    ).toEqual(["media-frag", "page-frag"]);
  });

  it("keeps inline payloads and skips the fragment calls", async () => {
    const seen: string[] = [];
    const inline = {
      "~kw:file": { "~kw:data": { "~kw:pages-index": { "~uuid:p1": { "~kw:objects": {} } } } },
    };
    stubFetch(seen, JSON.stringify(inline));
    const app = makeApp();

    const fileData = await fetchDecodedBundle(app, { fileId: "f1" });

    expect(seen.filter((u) => u.includes("get-file-fragment"))).toHaveLength(0);
    expect(new URL(seen[0], "http://localhost").searchParams.has("share-id")).toBe(false);
    const pagesIndex = getKey(app, fileData.fileData, "pages-index");
    expect(pagesIndex).toEqual(new Map([["uuid:p1", new Map([[kw("objects"), new Map()]])]]));
  });
});

// The cache is module-level and keyed by app instance, so every test here
// uses a fresh makeApp() and its own file id.
describe("loadDecodedBundle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads once per app and file/share pair", async () => {
    const seen: string[] = [];
    stubFetch(seen);
    const app = makeApp();

    const first = await loadDecodedBundle(app, { fileId: "f2" });
    // A missing share-id and an explicit null share the same cache slot.
    const second = await loadDecodedBundle(app, { fileId: "f2", shareId: null });

    expect(second.fileData).toBe(first.fileData);
    expect(seen.filter((u) => u.includes("get-view-only-bundle"))).toHaveLength(1);
  });

  it("keeps share-scoped entries apart", async () => {
    const seen: string[] = [];
    stubFetch(seen);
    const app = makeApp();

    const anonymous = await loadDecodedBundle(app, { fileId: "f3" });
    const shared = await loadDecodedBundle(app, { fileId: "f3", shareId: "s9" });

    expect(shared.fileData).not.toBe(anonymous.fileData);
    expect(seen.filter((u) => u.includes("get-view-only-bundle"))).toHaveLength(2);
  });

  it("evicts a failed load so a retry fetches again", async () => {
    const seen: string[] = [];
    const app = makeApp();

    // Junk bytes: the fetch succeeds and the CLJS decoder refuses the text.
    // The failure lands after the transport (no GET retry) and the rejected
    // cache entry must be evicted.
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 200 }));
    await expect(loadDecodedBundle(app, { fileId: "f4" })).rejects.toThrow();

    // The failed promise left the cache: the next call goes to the wire.
    stubFetch(seen);
    const bundle = await loadDecodedBundle(app, { fileId: "f4" });

    expect(getKey(app, bundle.fileData, "pages-index")).toBeInstanceOf(Map);
    expect(seen.filter((u) => u.includes("get-view-only-bundle"))).toHaveLength(1);
  });
});
