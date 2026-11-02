"use client";

// The canvas comment pins (F5.7): the port of the floating-bubbles family of
// app.main.ui.workspace.comments — one bubble per thread group at the thread
// position, placed in world coordinates and scaled by 1/zoom like the remote
// cursors, so a pin keeps its screen size at every zoom. groupBubbles
// (lib/workspace-comments) collapses the pins that sit closer than 32 screen
// pixels; a press opens the thread in the sidebar panel and a drag moves the
// pin (setThreadDragPosition during the gesture, moveThreadToPosition on drop
// — the CLJS update-comment-thread-position with the frame re-anchor).
//
// Deviations from the CLJS original, documented:
// - A grouped pin opens its first thread and the panel list shows the rest;
//   the CLJS expands the group into a floating card of avatars. Grouped pins
//   are not draggable — only a single-thread pin moves.
// - Pins are numbered circles, not owner avatars: the photo needs
//   resolve-profile-photo-url and the avatar stack is not ported yet. The
//   single-thread bubble carries the thread seqn, a group carries its count.
// - A pin click does not zoom to the thread.
// - The committed position does not join the undo stack yet (documented in
//   lib/workspace-comments-actions).

import { useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";

import {
  groupBubbles,
  screenDeltaToWorld,
  sortThreads,
  visibleThreads,
  type CommentPosition,
} from "@/lib/workspace-comments";
import {
  moveThreadToPosition,
  openCommentThread,
  setThreadDragPosition,
} from "@/lib/workspace-comments-actions";
import {
  getInitialWorkspaceState,
  getWorkspaceState,
  subscribeWorkspace,
} from "@/lib/workspace-store";

// The bubble radius in screen pixels (the CLJS draws a 32px avatar; the
// numbered circle keeps the same footprint).
const BUBBLE_RADIUS = 16;

// Screen pixels a pointer must travel before the press becomes a drag; below
// it, the release opens the thread like a plain click.
const DRAG_THRESHOLD_PX = 4;

export interface WorkspaceCommentBubblesProps {
  // Only the threads of the open page draw a pin.
  pageId: string;
  // The zoom of the overlay viewBox: the pins divide by it, so the circle
  // and its label keep one screen size at every zoom.
  zoom: number;
}

export function WorkspaceCommentBubbles({ pageId, zoom }: WorkspaceCommentBubblesProps) {
  const state = useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceState,
    getInitialWorkspaceState,
  );
  const comments = state.comments;

  const pageThreads = comments.threads.filter((thread) => thread["page-id"] === pageId);
  const threads = sortThreads(
    visibleThreads(pageThreads, { showResolved: comments.showResolved }),
  );
  const groups = zoom > 0 ? groupBubbles(threads, zoom) : [];

  // One gesture per pin: the client point the press landed on, the thread
  // position at press time and the dragged flag once the threshold passes.
  const dragRef = useRef<{
    threadId: string;
    startX: number;
    startY: number;
    origin: CommentPosition;
    current: CommentPosition;
    dragging: boolean;
    draggable: boolean;
  } | null>(null);

  if (groups.length === 0) return null;

  return (
    <g className="pp-comment-bubbles" data-testid="comment-bubbles">
      {groups.map((group) => {
        const first = group.threads[0];
        const unread = group.threads.some(
          (thread) => (thread["count-unread-comments"] ?? 0) > 0,
        );
        const resolved = group.threads.every((thread) => thread["is-resolved"] === true);
        const className = [
          "pp-comment-bubble",
          resolved ? "pp-comment-bubble--resolved" : "",
          unread ? "pp-comment-bubble--unread" : "",
        ]
          .filter((name) => name.length > 0)
          .join(" ");
        const label =
          group.threads.length > 1 ? String(group.threads.length) : String(first.seqn);
        const draggable = group.threads.length === 1;
        return (
          <g
            key={first.id}
            className={className}
            data-testid="comment-bubble"
            transform={`translate(${group.position.x} ${group.position.y}) scale(${1 / zoom})`}
          >
            {/* The handle pattern of the overlay: the layer ignores pointer
                events and this circle opts back in (pp-overlay-handle). A
                press under the threshold opens the thread; a drag moves the
                pin live and commits it on release. */}
            <circle
              className="pp-overlay-handle"
              r={BUBBLE_RADIUS}
              onPointerDown={(event: ReactPointerEvent<SVGCircleElement>) => {
                event.currentTarget.setPointerCapture(event.pointerId);
                dragRef.current = {
                  threadId: first.id,
                  startX: event.clientX,
                  startY: event.clientY,
                  origin: first.position,
                  current: first.position,
                  dragging: false,
                  draggable,
                };
              }}
              onPointerMove={(event: ReactPointerEvent<SVGCircleElement>) => {
                const drag = dragRef.current;
                if (drag === null || !drag.draggable) return;
                const dx = event.clientX - drag.startX;
                const dy = event.clientY - drag.startY;
                if (!drag.dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
                drag.dragging = true;
                const delta = screenDeltaToWorld(dx, dy, zoom);
                drag.current = { x: drag.origin.x + delta.x, y: drag.origin.y + delta.y };
                setThreadDragPosition(drag.threadId, drag.current);
              }}
              onPointerUp={() => {
                const drag = dragRef.current;
                dragRef.current = null;
                if (drag === null) return;
                if (drag.dragging) {
                  void moveThreadToPosition(drag.threadId, drag.current);
                } else {
                  void openCommentThread(drag.threadId);
                }
              }}
              onPointerCancel={() => {
                const drag = dragRef.current;
                dragRef.current = null;
                // Restore the pre-drag position; nothing was committed.
                if (drag !== null && drag.dragging) {
                  setThreadDragPosition(drag.threadId, drag.origin);
                }
              }}
            />
            <text className="pp-comment-bubble-label" textAnchor="middle" dominantBaseline="central">
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
}
