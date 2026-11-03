// Unit tests for the comments controller (F5.7): each action drives the RPC and
// writes the comments slice of the store, so the assertions read the store back
// after a stubbed fetch. The store is seeded directly for the actions that take
// their ids from the open-file slice (createThreadAtCenter).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encodeTransit } from "@/lib/transit";
import { ZERO_UUID } from "@/lib/file-data";
import {
  cancelCommentPlacement,
  closeCommentThread,
  createThreadAtCenter,
  createThreadAtPlacement,
  editCommentInThread,
  focusCommentThread,
  loadCommentMembers,
  loadCommentThreads,
  markAllLoadedRead,
  moveThreadToPosition,
  openCommentThread,
  registerCommentViewportFocus,
  removeThread,
  setCommentsFilter,
  setCommentsPanelOpen,
  setCommentsShowResolved,
  setPlacementPoint,
  setThreadDragPosition,
  startCommentPlacement,
  submitReply,
  toggleThreadResolved,
} from "@/lib/workspace-comments-actions";
import {
  getWorkspaceState,
  resetWorkspaceState,
  setWorkspaceComments,
  setWorkspaceState,
  setWorkspaceViewport,
} from "@/lib/workspace-store";
import type { Comment, CommentThread } from "@/lib/workspace-comments";

const FILE_ID = "11111111-2222-3333-4444-555555555555";
const PAGE_ID = "aaaaaaaabbbbccccdddd000000000001";
const THREAD_ID = "ccccccccdddd11112222333344445555";

function thread(over: Partial<CommentThread> & { id: string }): CommentThread {
  return {
    "page-id": PAGE_ID,
    "file-id": FILE_ID,
    "owner-id": "88888888-9999-0000-1111-222222222222",
    seqn: 1,
    content: "first",
    position: { x: 1, y: 2 },
    ...over,
  };
}

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

beforeEach(() => {
  resetWorkspaceState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadCommentThreads", () => {
  it("sets the threads and the ready status", async () => {
    const rows = [thread({ id: THREAD_ID })];
    stubFetch(jsonResponse(rows));
    await loadCommentThreads(FILE_ID);
    const { comments } = getWorkspaceState();
    expect(comments.status).toBe("ready");
    expect(comments.threads).toEqual(rows);
  });

  it("records the error status when the fetch fails", async () => {
    // A 500 with a transit error body raises a non-retryable RpcError; a
    // network failure would send the GET through the exponential-backoff
    // retries (1s + 2s + 4s) and outlive the test timeout.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(encodeTransit({ type: "internal", code: "boom" }), {
          status: 500,
          headers: { "content-type": "application/transit+json" },
        }),
    );
    await loadCommentThreads(FILE_ID);
    expect(getWorkspaceState().comments.status).toBe("error");
  });
});

describe("openCommentThread", () => {
  it("selects the thread, loads its replies and clears the unread badge", async () => {
    setWorkspaceComments({ threads: [thread({ id: THREAD_ID, "count-unread-comments": 3 })] });
    const replies: Comment[] = [{ id: "c1", "thread-id": THREAD_ID, "file-id": FILE_ID, "owner-id": "p", content: "hi" }];
    const calls = stubFetch(jsonResponse(replies));

    await openCommentThread(THREAD_ID);

    const { comments } = getWorkspaceState();
    expect(comments.openThreadId).toBe(THREAD_ID);
    expect(comments.panelOpen).toBe(true);
    expect(comments.replies[THREAD_ID]).toEqual(replies);
    expect(comments.threads[0]["count-unread-comments"]).toBe(0);
    // get-comments (GET) then update-comment-thread-status (POST).
    expect(calls.map((c) => c.init.method)).toEqual(["GET", "POST"]);
  });

  it("does not refetch replies already in the slice", async () => {
    setWorkspaceComments({
      threads: [thread({ id: THREAD_ID })],
      replies: { [THREAD_ID]: [] },
    });
    const calls = stubFetch(emptyResponse());
    await openCommentThread(THREAD_ID);
    // only the mark-read POST runs; no get-comments.
    expect(calls.every((c) => c.url.includes("update-comment-thread-status"))).toBe(true);
  });
});

describe("submitReply", () => {
  it("appends the answer and bumps the reply count", async () => {
    setWorkspaceComments({
      threads: [thread({ id: THREAD_ID, "count-comments": 1 })],
      replies: { [THREAD_ID]: [] },
    });
    const created: Comment = { id: "c2", "thread-id": THREAD_ID, "file-id": FILE_ID, "owner-id": "p", content: "yo" };
    stubFetch(jsonResponse(created));

    await submitReply(THREAD_ID, "yo");

    const { comments } = getWorkspaceState();
    expect(comments.replies[THREAD_ID]).toEqual([created]);
    expect(comments.threads[0]["count-comments"]).toBe(2);
  });
});

describe("editCommentInThread", () => {
  const first: Comment = { id: "c1", "thread-id": THREAD_ID, "file-id": FILE_ID, "owner-id": "p", content: "first" };
  const second: Comment = { id: "c2", "thread-id": THREAD_ID, "file-id": FILE_ID, "owner-id": "p", content: "second" };

  it("replaces the edited reply row without touching the thread projection", async () => {
    setWorkspaceComments({
      threads: [thread({ id: THREAD_ID, content: "first" })],
      replies: { [THREAD_ID]: [first, second] },
    });
    const calls = stubFetch(jsonResponse({ ...second, content: "edited" }));

    await editCommentInThread(THREAD_ID, "c2", "edited");

    expect(calls[0].url).toContain("update-comment");
    const { comments } = getWorkspaceState();
    expect(comments.replies[THREAD_ID].map((c) => c.content)).toEqual(["first", "edited"]);
    expect(comments.threads[0].content).toBe("first");
  });

  it("refreshes the content projection when the first comment is edited", async () => {
    setWorkspaceComments({
      threads: [thread({ id: THREAD_ID, content: "first" })],
      replies: { [THREAD_ID]: [first, second] },
    });
    stubFetch(jsonResponse({ ...first, content: "rewritten" }));

    await editCommentInThread(THREAD_ID, "c1", "rewritten");

    const { comments } = getWorkspaceState();
    expect(comments.replies[THREAD_ID][0].content).toBe("rewritten");
    expect(comments.threads[0].content).toBe("rewritten");
  });
});

describe("createThreadAtCenter", () => {
  it("places a thread at the viewport center and opens it", async () => {
    setWorkspaceState({ fileId: FILE_ID, pageId: PAGE_ID, objects: {}, vbox: { x: 0, y: 0, width: 100, height: 80 } });
    const row = thread({ id: THREAD_ID, position: { x: 50, y: 40 } });
    stubFetch(jsonResponse(row));

    const result = await createThreadAtCenter("hello");

    const { comments } = getWorkspaceState();
    expect(result?.id).toBe(THREAD_ID);
    expect(comments.threads.some((t) => t.id === THREAD_ID)).toBe(true);
    expect(comments.openThreadId).toBe(THREAD_ID);
    expect(comments.panelOpen).toBe(true);
  });

  it("returns null without an open file or page", async () => {
    stubFetch(jsonResponse(thread({ id: THREAD_ID })));
    expect(await createThreadAtCenter("hello")).toBeNull();
  });
});

describe("placement flow", () => {
  it("starts the placement covering the canvas with an open panel", () => {
    startCommentPlacement();
    const { comments } = getWorkspaceState();
    expect(comments.placing).toBe(true);
    expect(comments.placementPoint).toBeNull();
    expect(comments.panelOpen).toBe(true);
    expect(comments.openThreadId).toBeNull();
  });

  it("picks a point and cancels back to the idle flags", () => {
    setPlacementPoint({ x: 30, y: 40 });
    expect(getWorkspaceState().comments.placementPoint).toEqual({ x: 30, y: 40 });
    cancelCommentPlacement();
    const { comments } = getWorkspaceState();
    expect(comments.placing).toBe(false);
    expect(comments.placementPoint).toBeNull();
  });

  it("creates the thread at the picked point and leaves the placing mode", async () => {
    setWorkspaceState({ fileId: FILE_ID, pageId: PAGE_ID });
    startCommentPlacement();
    setPlacementPoint({ x: 30, y: 40 });
    const row = thread({ id: THREAD_ID, position: { x: 30, y: 40 } });
    const calls = stubFetch(jsonResponse(row));

    const result = await createThreadAtPlacement("here");

    expect(result?.id).toBe(THREAD_ID);
    const { comments } = getWorkspaceState();
    expect(comments.placing).toBe(false);
    expect(comments.placementPoint).toBeNull();
    expect(comments.threads.some((t) => t.id === THREAD_ID)).toBe(true);
    // The create-comment-thread leg ran before the resolved read.
    expect(calls[0].url).toContain("create-comment-thread");
  });

  it("keeps the placement open when there is no file to create on", async () => {
    startCommentPlacement();
    setPlacementPoint({ x: 1, y: 2 });
    stubFetch(jsonResponse(thread({ id: THREAD_ID })));
    expect(await createThreadAtPlacement("here")).toBeNull();
    expect(getWorkspaceState().comments.placing).toBe(true);
  });
});

describe("moveThreadToPosition", () => {
  it("re-anchors, patches the slice and commits the position", async () => {
    setWorkspaceComments({ threads: [thread({ id: THREAD_ID, position: { x: 1, y: 2 } })] });
    const calls = stubFetch(emptyResponse());

    await moveThreadToPosition(THREAD_ID, { x: 70, y: 80 });

    const moved = getWorkspaceState().comments.threads[0];
    expect(moved.position).toEqual({ x: 70, y: 80 });
    // No page objects are loaded, so the point re-anchors to the root frame.
    expect(moved["frame-id"]).toBe(ZERO_UUID);
    expect(calls[0].url).toContain("update-comment-thread-position");
  });
});

describe("setThreadDragPosition", () => {
  it("patches the position without talking to the backend", () => {
    setWorkspaceComments({ threads: [thread({ id: THREAD_ID, position: { x: 1, y: 2 } })] });
    const calls = stubFetch(emptyResponse());

    setThreadDragPosition(THREAD_ID, { x: 9, y: 4 });

    expect(getWorkspaceState().comments.threads[0].position).toEqual({ x: 9, y: 4 });
    expect(calls.length).toBe(0);
  });
});

describe("focusCommentThread", () => {
  afterEach(() => {
    registerCommentViewportFocus(null);
  });

  it("scales to ungroup, centers through the command and opens the thread", async () => {
    setWorkspaceViewport({
      zoom: 1,
      vbox: { x: 0, y: 0, width: 800, height: 600 },
      vport: { width: 800, height: 600 },
    });
    setWorkspaceComments({
      threads: [
        thread({ id: THREAD_ID, position: { x: 10, y: 0 } }),
        thread({ id: "other", position: { x: 0, y: 0 } }),
      ],
    });
    const seen: { position: { x: number; y: number }; scale: number }[] = [];
    registerCommentViewportFocus((position, scale) => seen.push({ position, scale }));
    stubFetch(emptyResponse());

    await focusCommentThread(THREAD_ID);

    // The pins overlap at zoom 1 (10 screen px), so the scale must exceed 1.
    expect(seen).toHaveLength(1);
    expect(seen[0].position).toEqual({ x: 10, y: 0 });
    expect(seen[0].scale).toBeGreaterThan(1);
    expect(getWorkspaceState().comments.openThreadId).toBe(THREAD_ID);
  });

  it("only opens the thread when no viewport command is registered", async () => {
    setWorkspaceViewport({
      zoom: 1,
      vbox: { x: 0, y: 0, width: 800, height: 600 },
      vport: { width: 800, height: 600 },
    });
    setWorkspaceComments({ threads: [thread({ id: THREAD_ID })] });
    stubFetch(emptyResponse());

    await focusCommentThread(THREAD_ID);

    expect(getWorkspaceState().comments.openThreadId).toBe(THREAD_ID);
    expect(getWorkspaceState().vbox).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });
});

describe("loadCommentMembers", () => {
  it("stores the team members for the mention autocomplete", async () => {
    const members = [
      { id: "99999999-0000-1111-2222-333333333333", email: "a@x.io", fullname: "Ann" },
    ];
    const calls = stubFetch(jsonResponse(members));

    await loadCommentMembers("11111111-2222-3333-4444-555555555555");

    expect(calls[0].url).toContain("get-team-members");
    expect(getWorkspaceState().comments.members).toEqual(members);
  });

  it("keeps the previous list when the fetch fails", async () => {
    setWorkspaceComments({ members: [{ id: "keep", fullname: "Kept" }] });
    // A 500 with a transit error body raises a non-retryable RpcError; a
    // network failure would send the GET through the retry backoffs.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(encodeTransit({ type: "internal", code: "boom" }), {
          status: 500,
          headers: { "content-type": "application/transit+json" },
        }),
    );

    await loadCommentMembers("11111111-2222-3333-4444-555555555555");

    expect(getWorkspaceState().comments.members).toEqual([{ id: "keep", fullname: "Kept" }]);
  });
});

describe("toggleThreadResolved", () => {
  it("flips the resolved flag in the slice", async () => {
    setWorkspaceComments({ threads: [thread({ id: THREAD_ID, "is-resolved": false })] });
    stubFetch(emptyResponse());
    await toggleThreadResolved(THREAD_ID, true);
    expect(getWorkspaceState().comments.threads[0]["is-resolved"]).toBe(true);
  });
});

describe("removeThread", () => {
  it("drops the thread and closes the panel when it was open", async () => {
    setWorkspaceComments({
      threads: [thread({ id: THREAD_ID }), thread({ id: "other" })],
      openThreadId: THREAD_ID,
    });
    stubFetch(emptyResponse());
    await removeThread(THREAD_ID);
    const { comments } = getWorkspaceState();
    expect(comments.threads.map((t) => t.id)).toEqual(["other"]);
    expect(comments.openThreadId).toBeNull();
  });
});

describe("markAllLoadedRead", () => {
  it("sends the ids and clears every unread badge", async () => {
    setWorkspaceComments({
      threads: [
        thread({ id: "a", "count-unread-comments": 2 }),
        thread({ id: "b", "count-unread-comments": 1 }),
      ],
    });
    const calls = stubFetch(emptyResponse());
    await markAllLoadedRead();
    const { comments } = getWorkspaceState();
    expect(comments.threads.every((t) => t["count-unread-comments"] === 0)).toBe(true);
    expect(calls[0].url).toContain("mark-all-threads-as-read");
  });

  it("is a no-op without threads", async () => {
    const calls = stubFetch(emptyResponse());
    await markAllLoadedRead();
    expect(calls).toHaveLength(0);
  });
});

describe("panel and filter flags", () => {
  it("toggles the panel, the filter and the resolved flag", () => {
    setCommentsPanelOpen(true);
    expect(getWorkspaceState().comments.panelOpen).toBe(true);
    setCommentsFilter("yours");
    expect(getWorkspaceState().comments.filter).toBe("yours");
    setCommentsShowResolved(true);
    expect(getWorkspaceState().comments.showResolved).toBe(true);
    closeCommentThread();
    expect(getWorkspaceState().comments.openThreadId).toBeNull();
  });
});
