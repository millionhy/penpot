import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeTransit, encodeTransit } from "@/lib/transit";
import { chunkRanges, uploadBlobChunked } from "@/lib/uploads";

describe("chunkRanges", () => {
  it("splits a blob into ceil(size / chunk-size) slices", () => {
    expect(chunkRanges(250, 100)).toEqual([
      { index: 0, start: 0, end: 100 },
      { index: 1, start: 100, end: 200 },
      { index: 2, start: 200, end: 250 },
    ]);
  });

  it("keeps an exactly divisible blob on whole chunks", () => {
    expect(chunkRanges(100, 100)).toEqual([{ index: 0, start: 0, end: 100 }]);
  });

  it("returns no ranges for an empty blob", () => {
    expect(chunkRanges(0, 100)).toEqual([]);
  });
});

// The two-step session: create-upload-session answers transit with the session
// id, every upload-chunk POST is a 204. The stub records the requests so the
// tests can pin the multipart shape cmdUpload builds.
interface RecordedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (String(url).includes("create-upload-session")) {
      return new Response(encodeTransit({ "session-id": "sess-1" }), {
        status: 200,
        headers: { "content-type": "application/transit+json" },
      });
    }
    return new Response(null, { status: 204 });
  });
  return calls;
}

function chunkCalls(calls: RecordedCall[]): Array<{ body: FormData }> {
  return calls
    .filter((call) => call.url.includes("upload-chunk"))
    .map((call) => ({ body: call.init.body as FormData }));
}

describe("uploadBlobChunked", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the session with the total chunk count and uploads every slice", async () => {
    const calls = stubFetch();
    const blob = new Blob([new Uint8Array(250)]);

    const result = await uploadBlobChunked(blob, { chunkSize: 100 });

    expect(result.sessionId).toBe("sess-1");
    expect(calls).toHaveLength(4);

    const create = calls[0];
    expect(create.url).toContain("create-upload-session");
    expect(decodeTransit(create.init.body as string)).toEqual({ "total-chunks": 3 });

    const uploads = chunkCalls(calls);
    expect(uploads).toHaveLength(3);
    // Workers run two at a time, so the completion order of the chunks is
    // not stable; index into them by the index field instead.
    const indices = uploads.map((call) => call.body.get("index")).sort();
    expect(indices).toEqual(["0", "1", "2"]);
    for (const call of uploads) {
      expect(call.body.get("session-id")).toBe("sess-1");
    }
  });

  it("sends each chunk as a named [Blob, filename] file part", async () => {
    const calls = stubFetch();

    await uploadBlobChunked(new Blob([new Uint8Array(250)]), { chunkSize: 100 });

    const uploads = chunkCalls(calls);
    const first = uploads.find((call) => call.body.get("index") === "0");
    const last = uploads.find((call) => call.body.get("index") === "2");
    expect(first).toBeDefined();
    expect(last).toBeDefined();

    const firstContent = first?.body.get("content") as File;
    expect(firstContent).toBeInstanceOf(File);
    expect(firstContent.name).toBe("chunk-0");
    expect(firstContent.size).toBe(100);

    // The final slice is cut short at the blob size.
    const lastContent = last?.body.get("content") as File;
    expect(lastContent.name).toBe("chunk-2");
    expect(lastContent.size).toBe(50);
  });

  it("skips the chunk uploads for an empty blob", async () => {
    const calls = stubFetch();

    const result = await uploadBlobChunked(new Blob([]), { chunkSize: 100 });

    expect(result.sessionId).toBe("sess-1");
    expect(calls).toHaveLength(1);
    expect(decodeTransit(calls[0].init.body as string)).toEqual({ "total-chunks": 0 });
  });
});
