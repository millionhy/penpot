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
// - Creating a thread places it at the center of the current viewport and
//   anchors it to the frame under that point, instead of a canvas click that
//   picks an arbitrary position (a later slice adds the click-to-place gesture).
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
  viewportCenter,
  type Comment,
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

// Create a thread at the viewport center anchored to the frame under it. The
// store carries the file, page, objects and viewport the CLJS reads off @state.
export async function createThreadAtCenter(content: string): Promise<CommentThread | null> {
  const state = getWorkspaceState();
  const fileId = state.fileId;
  const pageId = state.pageId;
  if (fileId === null || pageId === null) return null;

  const box = state.vbox ?? { x: 0, y: 0, width: 0, height: 0 };
  const position = viewportCenter(box);
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
