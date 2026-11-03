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
// - A moved pin joins the undo stack through the canvas update-file commit
//   pipeline (registerCommentMoveCommit) and syncs the comment-thread table
//   through the update-comment-thread-position RPC, the CLJS move-comment;
//   without a mounted canvas the drop falls back to the plain RPC.
// - A reply, a resolve and a delete update the local slice from the RPC answer
//   rather than refetching the whole thread list.

import {
  addComment,
  calculateZoomToUngroup,
  createCommentThread,
  deleteComment,
  deleteThread,
  editComment,
  frameIdForPosition,
  fetchCommentThreads,
  fetchComments,
  markAllThreadsRead,
  markThreadRead,
  setThreadResolved,
  threadById,
  updateThreadPosition,
  viewportCenter,
  type Comment,
  type CommentPosition,
  type CommentThread,
} from "@/lib/workspace-comments";
import { pageObjects } from "@/lib/workspace";
import type { UpdateFileSetCommentThreadPositionChange } from "@/lib/transit";
import { getTeamMembers } from "@/lib/team";
import {
  getWorkspaceState,
  getWorkspaceViewport,
  setWorkspaceComments,
} from "@/lib/workspace-store";

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

// Load the team members for the @mention autocomplete (the shell runs it on
// mount when the route carries a team-id). A failure leaves the previous list
// in place; an empty one keeps the suggestion popup closed.
export async function loadCommentMembers(teamId: string): Promise<void> {
  try {
    const members = await getTeamMembers(teamId);
    setWorkspaceComments({ members });
  } catch {
    /* the autocomplete stays without candidates */
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

// The viewport command of the canvas component (the single store write path,
// the registerPresencePointerSender pattern): focusing a thread scales the
// viewport to separate a grouped pin and centers its point. The shell
// registers it from the canvas handle; without one the focus only opens the
// thread.
export type CommentViewportFocus = (position: CommentPosition, zoomScale: number) => void;

let viewportFocus: CommentViewportFocus | null = null;

export function registerCommentViewportFocus(next: CommentViewportFocus | null): void {
  viewportFocus = next;
}

// Open a thread and bring its pin into view: the zoom that un-groups it from
// the page threads (calculateZoomToUngroup, the CLJS navigate flow) and the
// centering the canvas then applies.
export async function focusCommentThread(threadId: string): Promise<void> {
  const state = getWorkspaceState();
  const viewport = getWorkspaceViewport();
  const thread = threadById(state.comments.threads, threadId);
  if (viewport !== null && thread !== null) {
    const others = state.comments.threads
      .filter((t) => t["page-id"] === thread["page-id"] && t.id !== thread.id)
      .map((t) => t.position ?? { x: 0, y: 0 });
    const targetZoom = calculateZoomToUngroup(viewport.zoom, thread.position, others);
    if (viewportFocus !== null) viewportFocus(thread.position, targetZoom / viewport.zoom);
  }
  await openCommentThread(threadId);
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

// The canvas half of a pin drop (batch 7.58): the wasm canvas registers a
// function that sends a :set-comment-thread-position change through its
// update-file commit pipeline, so the move lands on the file projection AND
// on the undo stack, like the CLJS move-comment putting the change through
// dwc/commit. Null when no canvas is mounted; then a drop falls back to the
// plain RPC (no undo entry).
export type CommentMoveCommit = (
  change: UpdateFileSetCommentThreadPositionChange,
) => Promise<boolean>;

let commentMoveCommit: CommentMoveCommit | null = null;

export function registerCommentMoveCommit(commit: CommentMoveCommit | null): void {
  commentMoveCommit = commit;
}

// Move a pin: re-anchor it to the frame under the new point, update the
// slice optimistically, then commit the position like the CLJS
// update-comment-thread-position. With a canvas registered the change goes
// through the update-file pipeline (undo stack join) and the
// update-comment-thread-position RPC only syncs the comment-thread table
// afterwards, best-effort — the CLJS ::aux change, whose failures are logged
// only. Without one (or when the commit fails) the RPC is the write itself:
// failures bubble up; a failed commit restores the pre-drag placement, the
// CLJS :on-error rollback-position.
export async function moveThreadToPosition(
  threadId: string,
  position: CommentPosition,
): Promise<void> {
  const state = getWorkspaceState();
  const pageId = state.pageId;
  const objects =
    state.objects ?? (state.file && pageId !== null ? pageObjects(state.file, pageId) : {});
  const frameId = frameIdForPosition(objects, position);
  const thread = state.comments.threads.find((t) => t.id === threadId) ?? null;
  // The pre-drag placement the inverse restores (the slice keeps it as the
  // change's client-only companions; a thread always has a position).
  const undoPosition = thread?.position;
  const undoFrameId = thread?.["frame-id"];
  patchThread(threadId, { position, "frame-id": frameId });

  const commit = commentMoveCommit;
  if (thread !== null && commit !== null) {
    const committed = await commit({
      type: "set-comment-thread-position",
      "page-id": thread["page-id"],
      "comment-thread-id": threadId,
      "frame-id": frameId,
      position,
      undoPosition,
      undoFrameId,
    });
    if (!committed) {
      // The CLJS :on-error branch: roll the local state back.
      patchThread(threadId, { position: thread.position, "frame-id": undoFrameId });
      return;
    }
    void updateThreadPosition(threadId, position, frameId).catch((cause: unknown) => {
      console.warn("[comments] could not sync the pin position to the table:", cause);
    });
    return;
  }
  await updateThreadPosition(threadId, position, frameId);
}

// Undo/redo application of a pin move (batch 7.58): the history step has
// already persisted the change through update-file; this mirrors it into the
// comments slice and re-syncs the comment-thread table, the CLJS
// watch-undo-changes sync-comment-thread-position (which also swallows the
// RPC failure — the projection is the truth for rendering).
export function applyCommentThreadPositionChange(
  change: UpdateFileSetCommentThreadPositionChange,
): void {
  // The slice's position is the pin's truth: a nil (a move that detached
  // the thread) leaves the stored placement alone and only the frame anchor
  // changes; the backend drops the projection entry in that case.
  const patch: Partial<CommentThread> = { "frame-id": change["frame-id"] ?? undefined };
  if (change.position !== null) patch.position = change.position;
  patchThread(change["comment-thread-id"], patch);
  if (change.position !== null && change["frame-id"] !== null) {
    void updateThreadPosition(
      change["comment-thread-id"],
      change.position,
      change["frame-id"],
    ).catch((cause: unknown) => {
      console.warn("[comments] could not sync the undone pin position:", cause);
    });
  }
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

// Edit one comment of the open thread (own rows only, the CLJS options menu
// entry). The update-comment command answers with the fresh row, so the reply
// list takes its values; editing the first comment also refreshes the content
// projection the thread list and the pins read.
export async function editCommentInThread(
  threadId: string,
  commentId: string,
  content: string,
): Promise<void> {
  const updated = await editComment(commentId, content);
  const { comments } = getWorkspaceState();
  const current = comments.replies[threadId] ?? [];
  const isFirst = current.length > 0 && current[0].id === commentId;

  setWorkspaceComments({
    replies: {
      ...comments.replies,
      [threadId]: current.map((comment) =>
        comment.id === commentId ? { ...comment, ...updated, content } : comment,
      ),
    },
  });

  if (isFirst) patchThread(threadId, { content });
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
