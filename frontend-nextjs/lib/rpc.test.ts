import { afterEach, describe, expect, it, vi } from "vitest";
import { cmd, cmdUpload, parseSseBlocks } from "@/lib/rpc";
import { encodeTransit, set as transitSet } from "@/lib/transit";

// The blocks the backend sends for the bulk trash commands
// (app.rpc.commands.files): a "progress" block per file, then "end".
describe("parseSseBlocks", () => {
  it("reads a complete block", () => {
    const { blocks, rest } = parseSseBlocks('event: progress\ndata: {"~:index":1}\n\n');
    expect(blocks).toEqual([{ type: "progress", data: '{"~:index":1}' }]);
    expect(rest).toBe("");
  });

  it("reads several blocks at once and keeps their order", () => {
    const text =
      'event: progress\ndata: {"~:index":1}\n\n' +
      'event: progress\ndata: {"~:index":2}\n\n' +
      'event: end\ndata: {"~#set":[]}\n\n';
    expect(parseSseBlocks(text).blocks.map((block) => block.type)).toEqual([
      "progress",
      "progress",
      "end",
    ]);
  });

  it("hands back the trailing text of an incomplete block", () => {
    const { blocks, rest } = parseSseBlocks('event: progress\ndata: {"~:in');
    expect(blocks).toEqual([]);
    expect(rest).toBe('event: progress\ndata: {"~:in');
  });

  it("resumes across a chunk boundary", () => {
    const first = parseSseBlocks('event: progress\ndata: {"~:in');
    const second = parseSseBlocks(first.rest + 'dex":1}\n\nevent: end\ndata: 1\n\n');
    expect(second.blocks).toEqual([
      { type: "progress", data: '{"~:index":1}' },
      { type: "end", data: "1" },
    ]);
    expect(second.rest).toBe("");
  });

  it("defaults the event type to message and joins repeated data fields", () => {
    const { blocks } = parseSseBlocks("data: one\ndata: two\n\n");
    expect(blocks).toEqual([{ type: "message", data: "one\ntwo" }]);
  });

  it("drops comments, keep-alives and the single space after the colon", () => {
    const { blocks } = parseSseBlocks(": ping\n\n\nevent:end\ndata:no-space\n\n");
    expect(blocks).toEqual([
      { type: "end", data: "no-space" },
    ]);
  });

  it("accepts CRLF line and block endings", () => {
    const { blocks } = parseSseBlocks("event: progress\r\ndata: 1\r\n\r\n");
    expect(blocks).toEqual([{ type: "progress", data: "1" }]);
  });

  it("answers nothing for an empty buffer", () => {
    expect(parseSseBlocks("")).toEqual({ blocks: [], rest: "" });
  });
});

// conditional-decode-transit in app.util.http: a body decodes as transit only
// when the response announces the transit content type. The ::sm/text commands
// (get-nitrate-activation-code-request) answer plain text and must stay the
// raw string.
describe("conditional response decode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubTextResponse(body: string, contentType: string): void {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": contentType },
        }),
    );
  }

  it("hands back a non-transit body as the raw string", async () => {
    stubTextResponse("code-request-text", "text/plain");
    const result = await cmd<string>("get-nitrate-activation-code-request", {});
    expect(result).toBe("code-request-text");
  });

  it("decodes a body that carries the transit content type", async () => {
    stubTextResponse(encodeTransit({ "cancel-at": null }), "application/transit+json");
    const result = await cmd<Record<string, unknown>>(
      "get-nitrate-activation-code-request",
      {},
    );
    expect(result).toEqual({ "cancel-at": null });
  });

  it("applies the same rule to multipart uploads", async () => {
    stubTextResponse("plain answer", "text/plain");
    const result = await cmdUpload<string>("update-profile-photo", {
      file: new Blob([new Uint8Array(1)]),
    });
    expect(result).toBe("plain answer");
  });
});

// multipart-upload in repo.cljs: the body is FormData, the response transit.
// The stub records the request so the tests can pin how each param kind is
// appended to the multipart body.
interface RecordedCall {
  url: string;
  init: RequestInit;
}

function stubUploadFetch(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(null, { status: 204 });
  });
  return calls;
}

describe("cmdUpload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("appends a [Blob, filename] tuple as a named file part", async () => {
    const calls = stubUploadFetch();

    const result = await cmdUpload("upload-chunk", {
      "session-id": "sess-1",
      index: 0,
      content: [new Blob([new Uint8Array(16)]), "chunk-0"],
    });

    expect(result).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("upload-chunk");
    expect(calls[0].init.method).toBe("POST");
    const body = calls[0].init.body as FormData;
    // Numbers travel as strings; the backend parses them.
    expect(body.get("index")).toBe("0");
    expect(body.get("session-id")).toBe("sess-1");
    const content = body.get("content") as File;
    expect(content).toBeInstanceOf(File);
    expect(content.name).toBe("chunk-0");
    expect(content.size).toBe(16);
  });

  it("appends a bare blob under the default filename", async () => {
    const calls = stubUploadFetch();

    await cmdUpload("update-profile-photo", {
      file: new Blob([new Uint8Array(4)]),
      caption: "hello",
      missing: undefined,
    });

    const body = calls[0].init.body as FormData;
    const file = body.get("file") as File;
    expect(file.name).toBe("blob");
    expect(file.size).toBe(4);
    expect(body.get("caption")).toBe("hello");
    // undefined (and null) params are dropped, like send! in repo.cljs.
    expect(body.get("missing")).toBeNull();
  });
});

// GET query encoding: send! in repo.cljs hands the whole params map to
// u/map->query-string, where a collection value repeats the key once per
// element (lambdaisland/uri) and nil values disappear. The viewer bundle call
// sends its feature set this way; String(value) collapsed the transit set
// into a single "TransitSet {...}" entry and the backend answered
// :feature-not-supported.
describe("GET query encoding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubGetFetch(): RecordedCall[] {
    const calls: RecordedCall[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 204 });
    });
    return calls;
  }

  // The recorded URL is relative: config.publicUri defaults to "" and
  // same-origin requests are proxied by the Next rewrites.
  function sentParams(url: string): URLSearchParams {
    return new URL(url, "http://localhost").searchParams;
  }

  it("repeats the key once per element of a transit set", async () => {
    const calls = stubGetFetch();

    await cmd("get-view-only-bundle", {
      "file-id": "f1",
      features: transitSet(["fdata/path-data", "layout/grid"]),
      "share-id": "s1",
    });

    const params = sentParams(calls[0].url);
    expect(params.getAll("features").sort()).toEqual(["fdata/path-data", "layout/grid"]);
    expect(params.get("file-id")).toBe("f1");
    expect(params.get("share-id")).toBe("s1");
  });

  it("applies the same rule to arrays and JS sets", async () => {
    const calls = stubGetFetch();

    await cmd("get-file-fragment", { ids: ["a", "b"], other: new Set(["c", "d"]) });

    const params = sentParams(calls[0].url);
    expect(params.getAll("ids")).toEqual(["a", "b"]);
    expect(params.getAll("other")).toEqual(["c", "d"]);
  });

  it("drops undefined and null values", async () => {
    const calls = stubGetFetch();

    await cmd("get-file-fragment", { "file-id": "f1", missing: undefined, gone: null });

    const params = sentParams(calls[0].url);
    expect(params.has("missing")).toBe(false);
    expect(params.has("gone")).toBe(false);
    expect(params.get("file-id")).toBe("f1");
  });

  it("stringifies every other value", async () => {
    const calls = stubGetFetch();

    await cmd("get-file-fragment", { index: 0, flag: false });

    const params = sentParams(calls[0].url);
    expect(params.get("index")).toBe("0");
    expect(params.get("flag")).toBe("false");
  });
});
