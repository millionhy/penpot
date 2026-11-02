// The comments controller for the workspace (F5.7): the thin async glue that
// drives the RPC of lib/workspace-comments and writes the comments slice of
// lib/workspace-store from the answers. The sidebar panel and the canvas pin
// bubbles call these actions and read the store, so no callback is threaded
// across the canvas handle boundary.
//
// Deviations from the CLJS flow, documented:
// - The backend publishes no comment messages on the file websocket and
//   app.main.data.workspace.notifications has no comment routing, so comments
//   refresh through RPC (a load on mount and the optimistic writes below), not
//   a live push. This matches the reference app.
// - Creating a thread goes through the canvas click-to-place flow (see
//   startCommentPlacement); submitting without a click anchors the thread at
//   the center of the current viewport instead.
// - A moved pin commits through update-comment-thread-position but does not
//   join the undo stack yet (the shell undo only records page object changes).
// - A reply, a resolve and a delete update the local slice from the RPC answer
//   rather than refetching the whole thread list.

import {
  addComment,
  createCommentThread,
  deleteComment,
  deleteThread,
  frameIdForPosition,
  fetchCommentThreads,
  fetchComments,
  markAllThreadsRead,
  markThreadRead,
  setThreadResolved,
  updateThreadPosition,
  viewportCenter,
  type Comment,
  type CommentPosition,
  type CommentThread,
} from "@/lib/workspace-comments";
import { pageObjects } from "@/lib/workspace";
import { getWorkspaceState, setWorkspaceComments } from "@/lib/workspace-store";

// Replace one thread in the slice by id, keeping the array identity stable for
// the others so a partial update re-renders only what changed.
function patchThread(id: string, patch: Partial<CommentThread>): void {
  const { comments } = getWorkspaceState();
  setWorkspaceComments({
    threads: comments.threads.map((thread) =>
      thread.id === id ? { ...thread, ...patch } : thread,
    ),
  });
}

function appendReply(threadId: string, comment: Comment): void {
  const { comments } = getWorkspaceState();
  const current = comments.replies[threadId] ?? [];
  setWorkspaceComments({
    replies: { ...comments.replies, [threadId]: [...current, comment] },
  });
}

function removeReply(threadId: string, commentId: string): void {
  const { comments } = getWorkspaceState();
  const current = comments.replies[threadId] ?? [];
  setWorkspaceComments({
    replies: { ...comments.replies, [threadId]: current.filter((c) => c.id !== commentId) },
  });
}

// --- Load ------------------------------------------------------------------

// Load the threads of the open file. The shell runs it on mount; a failed load
// only sets the error status so the panel can show the empty state.
export async function loadCommentThreads(fileId: string): Promise<void> {
  setWorkspaceComments({ status: "loading" });
  try {
    const threads = await fetchCommentThreads(fileId);
    setWorkspaceComments({ status: "ready", threads });
  } catch {
    setWorkspaceComments({ status: "error" });
  }
}

// Re-read the whole list (the panel refresh button and after a create, whose
// resolved row the list query returns).
export async function refreshCommentThreads(fileId: string): Promise<void> {
  try {
    const threads = await fetchCommentThreads(fileId);
    setWorkspaceComments({ status: "ready", threads });
  } catch {
    setWorkspaceComments({ status: "error" });
  }
}

// --- Panel and thread selection --------------------------------------------

export function setCommentsPanelOpen(open: boolean): void {
  setWorkspaceComments({ panelOpen: open });
}

// The canvas click-to-place flow (the :comments drawing tool of the CLJS
// workspace): the placement layer covers the canvas, the first click picks
// the world point and the floating composer edits it. Starting the placement
// also opens the panel, so submitting shows the fresh thread.
export function startCommentPlacement(): void {
  setWorkspaceComments({
    placing: true,
    placementPoint: null,
    openThreadId: null,
    panelOpen: true,
  });
}

export function cancelCommentPlacement(): void {
  setWorkspaceComments({ placing: false, placementPoint: null });
}

export function setPlacementPoint(point: CommentPosition): void {
  setWorkspaceComments({ placementPoint: point });
}

export function closeCommentThread(): void {
  setWorkspaceComments({ openThreadId: null });
}

export function setCommentsFilter(filter: "all" | "yours" | "mentions"): void {
  setWorkspaceComments({ filter });
}

export function setCommentsShowResolved(showResolved: boolean): void {
  setWorkspaceComments({ showResolved });
}

// Open a thread in the panel: mark it read (clear the unread badge) and load
// its replies when they are not in the slice yet.
export async function openCommentThread(threadId: string): Promise<void> {
  const { comments } = getWorkspaceState();
  setWorkspaceComments({ openThreadId: threadId, panelOpen: true });

  if (comments.replies[threadId] === undefined && comments.loadingReplies[threadId] !== true) {
    setWorkspaceComments({
      loadingReplies: { ...comments.loadingReplies, [threadId]: true },
    });
    try {
      const rows = await fetchComments(threadId);
      const next = getWorkspaceState().comments;
      setWorkspaceComments({
        replies: { ...next.replies, [threadId]: rows },
        loadingReplies: { ...next.loadingReplies, [threadId]: false },
      });
    } catch {
      const next = getWorkspaceState().comments;
      setWorkspaceComments({ loadingReplies: { ...next.loadingReplies, [threadId]: false } });
    }
  }

  // Marking read is best-effort: a failure leaves the badge, the row is open.
  patchThread(threadId, { "count-unread-comments": 0 });
  await markThreadRead(threadId).catch(() => undefined);
}

// --- Mutations -------------------------------------------------------------

// Submit a reply on the open thread. The answer is appended to the slice.
export async function submitReply(threadId: string, content: string): Promise<void> {
  const comment = await addComment(threadId, content);
  appendReply(threadId, comment);
  const { comments } = getWorkspaceState();
  const thread = comments.threads.find((t) => t.id === threadId);
  if (thread !== undefined) {
    patchThread(threadId, { "count-comments": (thread["count-comments"] ?? 0) + 1 });
  }
}

// Create a thread at a world position anchored to the frame under it. The
// store carries the file, page and objects the CLJS reads off @state.
export async function createThreadAtPosition(
  content: string,
  position: CommentPosition,
): Promise<CommentThread | null> {
  const state = getWorkspaceState();
  const fileId = state.fileId;
  const pageId = state.pageId;
  if (fileId === null || pageId === null) return null;

  const objects = state.objects ?? (state.file ? pageObjects(state.file, pageId) : {});
  const frameId = frameIdForPosition(objects, position);

  const thread = await createCommentThread({ fileId, pageId, frameId, position, content });
  const { comments } = getWorkspaceState();
  setWorkspaceComments({ threads: [...comments.threads, thread] });
  setWorkspaceComments({ openThreadId: thread.id, panelOpen: true });
  // The list row only carries the first comment's content as a preview; load
  // the thread's replies so the open panel is authoritative.
  void fetchComments(thread.id)
    .then((rows) => {
      const next = getWorkspaceState().comments;
      setWorkspaceComments({ replies: { ...next.replies, [thread.id]: rows } });
    })
    .catch(() => undefined);
  return thread;
}

// Create a thread at the center of the current viewport (the fallback when
// the placement flow never got a click).
export async function createThreadAtCenter(content: string): Promise<CommentThread | null> {
  const box = getWorkspaceState().vbox ?? { x: 0, y: 0, width: 0, height: 0 };
  return createThreadAtPosition(content, viewportCenter(box));
}

// Submit the floating composer of the placement flow: create at the picked
// point (viewport center when no click landed) and leave the placing mode.
export async function createThreadAtPlacement(content: string): Promise<CommentThread | null> {
  const point = getWorkspaceState().comments.placementPoint;
  const thread = point !== null
    ? await createThreadAtPosition(content, point)
    : await createThreadAtCenter(content);
  if (thread !== null) cancelCommentPlacement();
  return thread;
}

// Live drag feedback for a pin: update the position in the slice without
// re-anchoring or talking to the backend; the drop commits through
// moveThreadToPosition.
export function setThreadDragPosition(threadId: string, position: CommentPosition): void {
  patchThread(threadId, { position });
}

// Move a pin: re-anchor it to the frame under the new point, update the slice
// and commit the position to the backend (the CLJS
// update-comment-thread-position). The optimistic write goes first, like the
// CLJS set-comment-thread before the RPC; the join of the position into the
// undo stack stays a documented delay (see the header).
export async function moveThreadToPosition(
  threadId: string,
  position: CommentPosition,
): Promise<void> {
  const state = getWorkspaceState();
  const pageId = state.pageId;
  const objects =
    state.objects ?? (state.file && pageId !== null ? pageObjects(state.file, pageId) : {});
  const frameId = frameIdForPosition(objects, position);
  patchThread(threadId, { position, "frame-id": frameId });
  await updateThreadPosition(threadId, position, frameId);
}

// Resolve or reopen a thread.
export async function toggleThreadResolved(threadId: string, isResolved: boolean): Promise<void> {
  await setThreadResolved(threadId, isResolved);
  patchThread(threadId, { "is-resolved": isResolved });
}

// Delete a thread and drop it from the slice; close the panel if it was open.
export async function removeThread(threadId: string): Promise<void> {
  await deleteThread(threadId);
  const { comments } = getWorkspaceState();
  setWorkspaceComments({ threads: comments.threads.filter((t) => t.id !== threadId) });
  if (getWorkspaceState().comments.openThreadId === threadId) closeCommentThread();
}

// Delete one reply from the open thread.
export async function removeReplyFromThread(threadId: string, commentId: string): Promise<void> {
  await deleteComment(commentId);
  removeReply(threadId, commentId);
}

// Mark every currently-loaded thread read: the command takes the ids, and the
// local unread counts clear without waiting for a refetch.
export async function markAllLoadedRead(): Promise<void> {
  const { comments } = getWorkspaceState();
  const ids = comments.threads.map((t) => t.id);
  if (ids.length === 0) return;
  await markAllThreadsRead(ids);
  setWorkspaceComments({
    threads: comments.threads.map((t) => ({ ...t, "count-unread-comments": 0 })),
  });
}
