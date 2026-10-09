import { afterEach, describe, expect, it, vi } from "vitest";
import { cmdUpload, parseSseBlocks } from "@/lib/rpc";

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
