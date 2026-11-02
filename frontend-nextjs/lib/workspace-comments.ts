// Workspace comments data layer (F5.7). Headless port of the comment slice of
// app.main.data.comments and app.main.data.workspace.comments plus the pure
// parts of app.main.ui.comments: the row shapes the RPC answers decode to, the
// mention/content parsing, the thread filtering and sorting, the frame
// resolution for a canvas position and the bubble grouping the overlay uses to
// collapse pins that sit close together.
//
// Kept free of JSX so it runs in vitest's node environment, like lib/team.ts
// and lib/workspace.ts. The views live in components/workspace-comments-*.tsx.
//
// Deviations from the CLJS original, documented:
// - The rows arrive with kebab-case string keys (transit decodes keyword keys
//   to strings at the lib/transit boundary), so every field is read through the
//   string key the reader produces rather than a Clojure keyword.
// - createCommentThread mirrors the CLJS two-step flow: create-comment-thread
//   then get-comment-thread, so the caller receives the fully resolved row the
//   backend answers (owner name/email/photo joined in the second read).
// - The backend has no reaction command in this version, so reactions are out
//   of scope; frame-move repositioning with undo, zoom-to-ungroup, the @mention
//   autocomplete and the dashboard unread card arrive with later slices.

import { ZERO_UUID } from "@/lib/file-data";
import { cmd } from "@/lib/rpc";
import { encodeRecordValue } from "@/lib/transit";
import type { InstantValue } from "@/lib/dashboard";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import type { RpcParams } from "@/lib/types";

// comment-max-length in backend/src/app/rpc/commands/comments.clj.
export const COMMENT_MAX_LENGTH = 750;

// BUBBLE-OVERLAP-PX: the 32 screen-pixel threshold in overlap-bubbles? of
// app.main.data.workspace.comments — two pins closer than this on screen are
// grouped into a single bubble.
export const BUBBLE_OVERLAP_PX = 32;

// The mention token @[fullname](profile-id) — r-mentions in the backend and in
// app.main.data.comments. Group 1 is the label, group 2 the profile uuid.
const R_MENTIONS = /@\[([^\]]*)\]\(([^\)]*)\)/g;

// --- Row shapes ------------------------------------------------------------

// The point the wire carries for a thread position (::gpt/point). It decodes to
// an {x,y} map; the CLJS gpt/point record is flattened at this boundary.
export interface CommentPosition {
  x: number;
  y: number;
}

// A row of get-comment-threads / get-comment-thread. The list query projects
// the joined owner/file/page fields and the two counts; the single-thread read
// carries the same keys, so one shape covers both.
export interface CommentThread {
  id: string;
  "page-id": string;
  "file-id": string;
  "project-id"?: string;
  "team-id"?: string;
  "owner-id": string;
  "owner-fullname"?: string;
  "owner-email"?: string;
  "owner-photo-id"?: string | null;
  "page-name"?: string;
  "file-name"?: string;
  "frame-id"?: string;
  seqn: number;
  // The content of the first comment (first_value over the ordered window).
  content: string;
  position: CommentPosition;
  // The participants and mentions are transit sets that decode to arrays.
  participants?: string[];
  mentions?: string[];
  "created-at"?: InstantValue;
  "modified-at"?: InstantValue;
  "count-comments"?: number;
  "count-unread-comments"?: number;
  "is-resolved"?: boolean;
}

// A row of get-comments / create-comment.
export interface Comment {
  id: string;
  "thread-id": string;
  "file-id": string;
  "owner-id": string;
  "owner-fullname"?: string;
  "owner-email"?: string;
  "owner-photo-id"?: string | null;
  content: string;
  mentions?: string[];
  "created-at"?: InstantValue;
  "modified-at"?: InstantValue;
}

// --- Date normalization ----------------------------------------------------

// lib/dashboard.ts hands back instants as a Date (the transit "~m" reader) or
// an ISO string (JSON fixtures); the same normalization team.ts applies.
function toMs(value: InstantValue | null | undefined): number {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? 0 : ms;
  }
  return 0;
}

// --- Content parsing -------------------------------------------------------

export type CommentSegment =
  | { kind: "text"; text: string }
  | { kind: "mention"; name: string; id: string };

// extract-mentions: the profile uuids referenced in the content, in order.
export function extractMentions(content: string): string[] {
  const ids: string[] = [];
  for (const match of content.matchAll(R_MENTIONS)) ids.push(match[2]);
  return ids;
}

// valid-comment-content?: a comment is submittable when it has visible text
// other than a lone zero-width space (the placeholder the editor leaves behind).
export function validCommentContent(content: string): boolean {
  if (typeof content !== "string") return false;
  const trimmed = content.trim();
  return trimmed.length > 0 && trimmed !== "\u200b";
}

// format-comment: replace every @[name](id) token with its label, for the
// plain-text preview the notifications and the collapsed bubble use.
export function formatCommentContent(content: string): string {
  return content.replace(R_MENTIONS, "$1");
}

// Split the content into text and mention segments so the view can render the
// mentions as chips while keeping the raw @[name](id) form for editing.
export function parseCommentContent(content: string): CommentSegment[] {
  const segments: CommentSegment[] = [];
  let last = 0;
  for (const match of content.matchAll(R_MENTIONS)) {
    const start = match.index ?? 0;
    if (start > last) segments.push({ kind: "text", text: content.slice(last, start) });
    segments.push({ kind: "mention", name: match[1], id: match[2] });
    last = start + match[0].length;
  }
  if (last < content.length) segments.push({ kind: "text", text: content.slice(last) });
  return segments;
}

// --- Thread filtering, sorting and visibility ------------------------------

export function isThreadUnread(thread: CommentThread): boolean {
  return (thread["count-unread-comments"] ?? 0) > 0;
}

// Order threads by creation time (oldest first), then by id so a tie is stable
// across loads. The sidebar and the pin list share this order.
export function sortThreads(threads: readonly CommentThread[]): CommentThread[] {
  return [...threads].sort((a, b) => {
    const delta = toMs(a["created-at"]) - toMs(b["created-at"]);
    if (delta !== 0) return delta;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

export interface ThreadFilter {
  // When false (default) resolved threads are hidden, matching the CLJS
  // hide-resolved-comments default; the toggle passes true.
  showResolved?: boolean;
  // When set, keep only the threads this profile owns or participates in — the
  // show-your-comments filter.
  onlyForProfile?: string | null;
}

export function visibleThreads(
  threads: readonly CommentThread[],
  filter: ThreadFilter = {},
): CommentThread[] {
  const showResolved = filter.showResolved ?? false;
  const onlyForProfile = filter.onlyForProfile ?? null;
  return threads.filter((thread) => {
    if (!showResolved && thread["is-resolved"] === true) return false;
    if (onlyForProfile !== null) {
      const isOwner = thread["owner-id"] === onlyForProfile;
      const isParticipant = (thread.participants ?? []).includes(onlyForProfile);
      if (!isOwner && !isParticipant) return false;
    }
    return true;
  });
}

// The threads that mention a profile — the show-mentions filter. A null
// profile keeps everything (an anonymous viewer has no mentions of its own).
export function threadsMentioning(
  threads: readonly CommentThread[],
  profileId: string | null,
): CommentThread[] {
  if (profileId === null) return [...threads];
  return threads.filter((thread) => (thread.mentions ?? []).includes(profileId));
}

// The thread with an id, or null when it is gone (after a delete) or the id is
// unset.
export function threadById(
  threads: readonly CommentThread[],
  id: string | null,
): CommentThread | null {
  if (id === null) return null;
  return threads.find((thread) => thread.id === id) ?? null;
}

// The world center of the current viewport box — where a thread is placed when
// it is created without a canvas click (see the panel header note).
export function viewportCenter(box: {
  x: number;
  y: number;
  width: number;
  height: number;
}): CommentPosition {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// --- Coordinate mapping ----------------------------------------------------

// A box in screen (client) coordinates: the getBoundingClientRect of the
// overlay svg element.
export interface ClientBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// The inverse of the overlay's viewBox mapping: a client point on the svg
// element maps into the world vbox space (the role of the CLJS pointer
// conversion for the comments tool click). A degenerate element box (zero
// size, e.g. mid-animation) falls back to the vbox origin.
export function clientPointToWorld(
  box: ClientBox,
  vbox: ClientBox,
  clientX: number,
  clientY: number,
): CommentPosition {
  if (box.width <= 0 || box.height <= 0) return { x: vbox.x, y: vbox.y };
  return {
    x: vbox.x + ((clientX - box.x) / box.width) * vbox.width,
    y: vbox.y + ((clientY - box.y) / box.height) * vbox.height,
  };
}

// A screen-pixel drag delta in world units: the pins scale by 1/zoom, so the
// pointer travel divides by the zoom to follow the cursor exactly. A
// non-positive zoom freezes the point instead of dividing by zero.
export function screenDeltaToWorld(dx: number, dy: number, zoom: number): CommentPosition {
  const k = zoom > 0 ? 1 / zoom : 0;
  return { x: dx * k, y: dy * k };
}

// --- Frame resolution ------------------------------------------------------

function containsPoint(shape: WorkspaceShape, point: CommentPosition): boolean {
  const rect = shape["selrect"] as
    | { x?: number; y?: number; width?: number; height?: number }
    | undefined;
  if (
    rect !== undefined &&
    typeof rect.x === "number" &&
    typeof rect.y === "number" &&
    typeof rect.width === "number" &&
    typeof rect.height === "number"
  ) {
    return (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    );
  }
  const points = shape.points;
  if (points !== undefined && points.length > 0) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
  }
  return false;
}

// The number of ancestors above a shape, used to prefer the deepest containing
// frame. Walks parent-id until the root or a missing link; a visited set guards
// against a malformed cycle.
function depthOf(objects: WorkspaceObjects, id: string): number {
  let depth = 0;
  const visited = new Set<string>([id]);
  let current = objects[id]?.["parent-id"];
  while (current !== undefined && current !== null && objects[current] && !visited.has(current)) {
    visited.add(current);
    depth += 1;
    current = objects[current]?.["parent-id"];
  }
  return depth;
}

// ctst/get-frame-id-by-position: the deepest frame that contains the point, or
// the root id when the point sits outside every frame. create-comment-thread
// requires a frame-id, and the root is a valid one.
export function frameIdForPosition(objects: WorkspaceObjects, point: CommentPosition): string {
  let bestId: string | null = null;
  let bestDepth = -1;
  for (const shape of Object.values(objects)) {
    if (shape.type !== "frame") continue;
    if (!containsPoint(shape, point)) continue;
    const depth = depthOf(objects, shape.id);
    if (depth > bestDepth) {
      bestDepth = depth;
      bestId = shape.id;
    }
  }
  return bestId ?? ZERO_UUID;
}

// --- Bubble grouping -------------------------------------------------------

// bubblesOverlap?: two pins at world positions a and b collapse into one bubble
// when their on-screen distance (world distance scaled by zoom) is under the
// threshold. A larger zoom spreads them apart, so grouping tightens as you zoom
// out.
export function bubblesOverlap(
  zoom: number,
  a: CommentPosition,
  b: CommentPosition,
  thresholdPx = BUBBLE_OVERLAP_PX,
): boolean {
  const distance = Math.hypot(a.x - b.x, a.y - b.y);
  return distance * zoom < thresholdPx;
}

export interface BubbleGroup {
  // The anchor of the group — the position of its first thread; the bubble is
  // drawn here.
  position: CommentPosition;
  threads: CommentThread[];
}

// group-bubbles: greedily bucket threads whose positions overlap at the current
// zoom, in the order they arrive (so the grouping is stable). Each bucket keeps
// the first thread's position as its anchor.
export function groupBubbles(
  threads: readonly CommentThread[],
  zoom: number,
): BubbleGroup[] {
  const groups: BubbleGroup[] = [];
  for (const thread of threads) {
    const position = thread.position ?? { x: 0, y: 0 };
    const target = groups.find((group) => bubblesOverlap(zoom, group.position, position));
    if (target !== undefined) target.threads.push(thread);
    else groups.push({ position, threads: [thread] });
  }
  return groups;
}

// --- Commands --------------------------------------------------------------

// get-comment-threads for one file (GET: the command name starts with "get-").
export function fetchCommentThreads(fileId: string): Promise<CommentThread[]> {
  const params = { "file-id": fileId } as RpcParams["get-comment-threads"];
  return cmd<CommentThread[]>("get-comment-threads", params);
}

// get-comment-thread: the fully resolved single row (owner fields joined).
export function fetchCommentThread(fileId: string, id: string): Promise<CommentThread> {
  const params = { "file-id": fileId, id } as RpcParams["get-comment-thread"];
  return cmd<CommentThread>("get-comment-thread", params);
}

// get-comments for one thread.
export function fetchComments(threadId: string): Promise<Comment[]> {
  const params = { "thread-id": threadId } as RpcParams["get-comments"];
  return cmd<Comment[]>("get-comments", params);
}

export interface CreateThreadInput {
  fileId: string;
  pageId: string;
  position: CommentPosition;
  content: string;
  // The frame the position resolves to; the caller derives it with
  // frameIdForPosition when it creates a thread from a canvas click.
  frameId: string;
}

// create-thread-on-workspace: create-comment-thread then get-comment-thread, so
// the caller gets the resolved row. Mentions come from the content.
export async function createCommentThread(input: CreateThreadInput): Promise<CommentThread> {
  const created = await cmd<{ id?: string }>("create-comment-thread", {
    "file-id": input.fileId,
    "page-id": input.pageId,
    "frame-id": input.frameId,
    position: encodeRecordValue("point", input.position),
    content: input.content,
    mentions: extractMentions(input.content),
  });
  return fetchCommentThread(input.fileId, created.id ?? "");
}

// create-comment: an answer inside an existing thread.
export function addComment(threadId: string, content: string): Promise<Comment> {
  const params = {
    "thread-id": threadId,
    content,
    mentions: extractMentions(content),
  } as RpcParams["create-comment"];
  return cmd<Comment>("create-comment", params);
}

// update-comment: edit the content of an existing comment.
export function editComment(id: string, content: string): Promise<Comment> {
  const params = {
    id,
    content,
    mentions: extractMentions(content),
  } as RpcParams["update-comment"];
  return cmd<Comment>("update-comment", params);
}

// update-comment-thread: resolve or reopen a thread.
export function setThreadResolved(id: string, isResolved: boolean): Promise<unknown> {
  const params = { id, "is-resolved": isResolved } as RpcParams["update-comment-thread"];
  return cmd("update-comment-thread", params);
}

// update-comment-thread-status: mark one thread read for the current profile.
export function markThreadRead(id: string): Promise<unknown> {
  const params = { id } as RpcParams["update-comment-thread-status"];
  return cmd("update-comment-thread-status", params);
}

// mark-all-threads-as-read for the given thread ids.
export function markAllThreadsRead(threads: readonly string[]): Promise<unknown> {
  const params = { threads: [...threads] } as RpcParams["mark-all-threads-as-read"];
  return cmd("mark-all-threads-as-read", params);
}

// update-comment-thread-position: move a pin (and re-anchor it to a frame).
export function updateThreadPosition(
  id: string,
  position: CommentPosition,
  frameId: string,
): Promise<unknown> {
  return cmd("update-comment-thread-position", {
    id,
    position: encodeRecordValue("point", position),
    "frame-id": frameId,
  });
}

// delete-comment-thread and delete-comment.
export function deleteThread(id: string): Promise<unknown> {
  const params = { id } as RpcParams["delete-comment-thread"];
  return cmd("delete-comment-thread", params);
}

export function deleteComment(id: string): Promise<unknown> {
  const params = { id } as RpcParams["delete-comment"];
  return cmd("delete-comment", params);
}
