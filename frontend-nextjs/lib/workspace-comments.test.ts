// Unit tests for the workspace comments data layer (F5.7): the content/mention
// parsing, the thread filtering, sorting and visibility, the frame resolution
// for a canvas position, the bubble grouping, and the command wrappers. The
// fetch stub records the request; the POST body is the transit document
// encodeParams writes, so decodeTransit reads it back and pins the values that
// must travel as a point record or a mention array.

import { afterEach, describe, expect, it, vi } from "vitest";

import { decodeTransit, encodeTransit } from "@/lib/transit";
import {
  addComment,
  BUBBLE_OVERLAP_PX,
  bubblesOverlap,
  COMMENT_MAX_LENGTH,
  createCommentThread,
  editComment,
  extractMentions,
  fetchCommentThread,
  fetchCommentThreads,
  formatCommentContent,
  frameIdForPosition,
  groupBubbles,
  isThreadUnread,
  markAllThreadsRead,
  markThreadRead,
  parseCommentContent,
  setThreadResolved,
  sortThreads,
  threadById,
  threadsMentioning,
  updateThreadPosition,
  validCommentContent,
  viewportCenter,
  visibleThreads,
  type CommentThread,
} from "@/lib/workspace-comments";
import type { WorkspaceObjects } from "@/lib/workspace";

const FILE_ID = "11111111-2222-3333-4444-555555555555";
const PAGE_ID = "aaaaaaaabbbbccccdddd000000000001";
const THREAD_ID = "ccccccccdddd11112222333344445555";
const ROOT = "00000000-0000-0000-0000-000000000000";
const ALICE = "88888888-9999-0000-1111-222222222222";
const BOB = "99999999-0000-1111-2222-333333333333";

// --- Content / mention parsing ---------------------------------------------

describe("extractMentions", () => {
  it("collects the profile ids of every mention token, in order", () => {
    const content = `hi @[Alice](${ALICE}) and @[Bob](${BOB})`;
    expect(extractMentions(content)).toEqual([ALICE, BOB]);
  });

  it("returns an empty list when there is no mention", () => {
    expect(extractMentions("plain text")).toEqual([]);
  });
});

describe("validCommentContent", () => {
  it("rejects blank, whitespace-only and lone zero-width-space content", () => {
    expect(validCommentContent("")).toBe(false);
    expect(validCommentContent("   \n ")).toBe(false);
    expect(validCommentContent("\u200b")).toBe(false);
  });

  it("accepts content with visible text", () => {
    expect(validCommentContent("looks good")).toBe(true);
    expect(validCommentContent(`@[Alice](${ALICE})`)).toBe(true);
  });
});

describe("formatCommentContent", () => {
  it("replaces every mention token with its label", () => {
    expect(formatCommentContent(`hey @[Alice](${ALICE})!`)).toBe("hey Alice!");
  });
});

describe("parseCommentContent", () => {
  it("splits text and mention segments around the tokens", () => {
    const segments = parseCommentContent(`a @[Alice](${ALICE}) b`);
    expect(segments).toEqual([
      { kind: "text", text: "a " },
      { kind: "mention", name: "Alice", id: ALICE },
      { kind: "text", text: " b" },
    ]);
  });

  it("keeps all-text content as a single text segment", () => {
    expect(parseCommentContent("just text")).toEqual([{ kind: "text", text: "just text" }]);
  });
});

// --- Thread filtering and sorting ------------------------------------------

function thread(over: Partial<CommentThread> & { id: string }): CommentThread {
  return {
    "page-id": PAGE_ID,
    "file-id": FILE_ID,
    "owner-id": ALICE,
    seqn: 1,
    content: "c",
    position: { x: 0, y: 0 },
    ...over,
  };
}

describe("isThreadUnread", () => {
  it("reads the unread count and defaults a missing one to read", () => {
    expect(isThreadUnread(thread({ id: "t1", "count-unread-comments": 2 }))).toBe(true);
    expect(isThreadUnread(thread({ id: "t2", "count-unread-comments": 0 }))).toBe(false);
    expect(isThreadUnread(thread({ id: "t3" }))).toBe(false);
  });
});

describe("sortThreads", () => {
  it("orders by creation time oldest first and breaks ties by id", () => {
    const a = thread({ id: "b", "created-at": new Date(2000) });
    const b = thread({ id: "a", "created-at": new Date(1000) });
    const c = thread({ id: "c", "created-at": "1970-01-01T00:00:02Z" });
    expect(sortThreads([a, b, c]).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});

describe("visibleThreads", () => {
  const items = [
    thread({ id: "open", "is-resolved": false, "owner-id": ALICE }),
    thread({ id: "resolved", "is-resolved": true, "owner-id": ALICE }),
    thread({ id: "other", "owner-id": BOB, participants: [BOB] }),
    thread({ id: "participating", "owner-id": BOB, participants: [ALICE, BOB] }),
  ];

  it("hides resolved threads by default", () => {
    expect(visibleThreads(items).map((t) => t.id)).toEqual(["open", "other", "participating"]);
  });

  it("keeps resolved threads when asked", () => {
    expect(visibleThreads(items, { showResolved: true }).map((t) => t.id)).toEqual([
      "open",
      "resolved",
      "other",
      "participating",
    ]);
  });

  it("keeps only owned or participated threads for a profile", () => {
    const mine = visibleThreads(items, { onlyForProfile: ALICE });
    expect(mine.map((t) => t.id)).toEqual(["open", "participating"]);
  });
});

describe("threadsMentioning", () => {
  const items = [
    thread({ id: "t1", mentions: [ALICE] }),
    thread({ id: "t2", mentions: [BOB] }),
    thread({ id: "t3" }),
  ];

  it("keeps the threads that mention the profile", () => {
    expect(threadsMentioning(items, ALICE).map((t) => t.id)).toEqual(["t1"]);
  });

  it("keeps everything for a null profile", () => {
    expect(threadsMentioning(items, null)).toHaveLength(3);
  });
});

describe("threadById", () => {
  const items = [thread({ id: "t1" })];

  it("finds the thread and returns null when missing or unset", () => {
    expect(threadById(items, "t1")?.id).toBe("t1");
    expect(threadById(items, "nope")).toBeNull();
    expect(threadById(items, null)).toBeNull();
  });
});

describe("viewportCenter", () => {
  it("returns the world center of the box", () => {
    expect(viewportCenter({ x: 0, y: 10, width: 200, height: 100 })).toEqual({ x: 100, y: 60 });
  });
});

// --- Frame resolution ------------------------------------------------------

const objects: WorkspaceObjects = {
  [ROOT]: { id: ROOT, type: "frame", name: "root", shapes: ["outer"] },
  outer: {
    id: "outer",
    type: "frame",
    "parent-id": ROOT,
    shapes: ["inner"],
    selrect: { x: 0, y: 0, width: 400, height: 400 },
  },
  inner: {
    id: "inner",
    type: "frame",
    "parent-id": "outer",
    shapes: [],
    selrect: { x: 100, y: 100, width: 100, height: 100 },
  },
  rect: { id: "rect", type: "rect", "parent-id": ROOT, selrect: { x: 0, y: 0, width: 10, height: 10 } },
};

describe("frameIdForPosition", () => {
  it("picks the deepest frame containing the point", () => {
    expect(frameIdForPosition(objects, { x: 150, y: 150 })).toBe("inner");
    expect(frameIdForPosition(objects, { x: 50, y: 50 })).toBe("outer");
  });

  it("ignores non-frame shapes", () => {
    // (150,150) is inside inner; the tiny rect at the origin never contains it,
    // and even if a non-frame did, it must not be returned.
    expect(frameIdForPosition(objects, { x: 5, y: 5 })).toBe("outer");
  });

  it("falls back to the root when no frame contains the point", () => {
    expect(frameIdForPosition(objects, { x: 999, y: 999 })).toBe(ROOT);
  });
});

// --- Bubble grouping -------------------------------------------------------

describe("bubblesOverlap", () => {
  it("compares the on-screen distance against the threshold", () => {
    const a = { x: 0, y: 0 };
    // world distance 10 -> 20 screen px at zoom 2 (< 32 overlap),
    // 80 screen px at zoom 8 (>= 32 no overlap).
    expect(bubblesOverlap(2, a, { x: 10, y: 0 })).toBe(true);
    expect(bubblesOverlap(8, a, { x: 10, y: 0 })).toBe(false);
  });

  it("exposes the 32px threshold", () => {
    expect(BUBBLE_OVERLAP_PX).toBe(32);
  });
});

describe("groupBubbles", () => {
  it("buckets threads whose pins overlap and keeps the first position as anchor", () => {
    const items = [
      thread({ id: "a", position: { x: 0, y: 0 } }),
      thread({ id: "b", position: { x: 5, y: 0 } }), // overlaps a at zoom 1
      thread({ id: "c", position: { x: 500, y: 500 } }), // far away
    ];
    const groups = groupBubbles(items, 1);
    expect(groups).toHaveLength(2);
    expect(groups[0].threads.map((t) => t.id)).toEqual(["a", "b"]);
    expect(groups[0].position).toEqual({ x: 0, y: 0 });
    expect(groups[1].threads.map((t) => t.id)).toEqual(["c"]);
  });
});

describe("constants", () => {
  it("pins the backend max length", () => {
    expect(COMMENT_MAX_LENGTH).toBe(750);
  });
});

// --- Commands --------------------------------------------------------------

interface RecordedCall {
  url: string;
  init: RequestInit;
}

function stubFetch(response: () => Response): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  });
  return calls;
}

function jsonResponse(payload: unknown): () => Response {
  return () =>
    new Response(encodeTransit(payload), {
      status: 200,
      headers: { "content-type": "application/transit+json" },
    });
}

function emptyResponse(): () => Response {
  return () => new Response(null, { status: 204 });
}

function bodyOf(call: RecordedCall): string {
  return call.init.body as string;
}

function decodeBody(call: RecordedCall): Record<string, unknown> {
  return decodeTransit<Record<string, unknown>>(bodyOf(call));
}

describe("comment commands", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches the threads of a file with a GET and the file-id query", async () => {
    const rows = [thread({ id: THREAD_ID })];
    const calls = stubFetch(jsonResponse(rows));
    const result = await fetchCommentThreads(FILE_ID);
    expect(calls).toHaveLength(1);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].url).toContain("get-comment-threads");
    expect(calls[0].url).toContain("file-id=");
    expect(result).toEqual(rows);
  });

  it("fetches a single thread with a GET carrying file-id and id", async () => {
    const calls = stubFetch(jsonResponse(thread({ id: THREAD_ID })));
    await fetchCommentThread(FILE_ID, THREAD_ID);
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].url).toContain("get-comment-thread?");
    expect(calls[0].url).toContain("id=");
  });

  it("creates a thread then re-reads it, sending position as a point and mentions from content", async () => {
    const resolved = thread({ id: THREAD_ID });
    const calls = stubFetch(jsonResponse(resolved));
    const result = await createCommentThread({
      fileId: FILE_ID,
      pageId: PAGE_ID,
      frameId: "outer",
      position: { x: 12, y: 34 },
      content: `hi @[Bob](${BOB})`,
    });

    // Two calls: create-comment-thread (POST) then get-comment-thread (GET).
    expect(calls).toHaveLength(2);
    expect(calls[0].init.method).toBe("POST");
    const body = decodeBody(calls[0]);
    expect(body["file-id"]).toBe(FILE_ID);
    expect(body["page-id"]).toBe(PAGE_ID);
    expect(body["frame-id"]).toBe("outer");
    expect(body["content"]).toBe(`hi @[Bob](${BOB})`);
    expect(body["position"]).toEqual({ x: 12, y: 34 });
    expect(body["mentions"]).toEqual([BOB]);
    expect(calls[1].url).toContain("get-comment-thread?");
    expect(result).toEqual(resolved);
  });

  it("adds a reply with the thread id, content and mentions", async () => {
    const calls = stubFetch(jsonResponse({ id: "c1", "thread-id": THREAD_ID }));
    await addComment(THREAD_ID, `ok @[Alice](${ALICE})`);
    expect(calls[0].init.method).toBe("POST");
    const body = decodeBody(calls[0]);
    expect(body["thread-id"]).toBe(THREAD_ID);
    expect(body["content"]).toBe(`ok @[Alice](${ALICE})`);
    expect(body["mentions"]).toEqual([ALICE]);
  });

  it("edits a comment content and mentions", async () => {
    const calls = stubFetch(jsonResponse({ id: "c1" }));
    await editComment("c1", `edited @[Bob](${BOB})`);
    const body = decodeBody(calls[0]);
    expect(body["id"]).toBe("c1");
    expect(body["mentions"]).toEqual([BOB]);
  });

  it("resolves a thread with the is-resolved flag", async () => {
    const calls = stubFetch(emptyResponse());
    await setThreadResolved(THREAD_ID, true);
    expect(decodeBody(calls[0])).toEqual({ id: THREAD_ID, "is-resolved": true });
  });

  it("marks one thread read via the status command", async () => {
    const calls = stubFetch(emptyResponse());
    await markThreadRead(THREAD_ID);
    expect(decodeBody(calls[0])).toEqual({ id: THREAD_ID });
  });

  it("marks many threads read with the threads array", async () => {
    const calls = stubFetch(emptyResponse());
    await markAllThreadsRead(["a", "b"]);
    expect(decodeBody(calls[0])).toEqual({ threads: ["a", "b"] });
  });

  it("moves a pin sending position as a point and the new frame id", async () => {
    const calls = stubFetch(emptyResponse());
    await updateThreadPosition(THREAD_ID, { x: 7, y: 9 }, "inner");
    const body = decodeBody(calls[0]);
    expect(body["id"]).toBe(THREAD_ID);
    expect(body["position"]).toEqual({ x: 7, y: 9 });
    expect(body["frame-id"]).toBe("inner");
  });
});
