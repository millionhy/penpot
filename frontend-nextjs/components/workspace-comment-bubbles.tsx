"use client";

// The canvas comment pins (F5.7): the port of the floating-bubbles family of
// app.main.ui.workspace.comments — one bubble per thread group at the thread
// position, placed in world coordinates and scaled by 1/zoom like the remote
// cursors, so a pin keeps its screen size at every zoom. groupBubbles
// (lib/workspace-comments) collapses the pins that sit closer than 32 screen
// pixels; a press opens the thread in the sidebar panel.
//
// Deviations from the CLJS original, documented:
// - A grouped pin opens its first thread and the panel list shows the rest;
//   the CLJS expands the group into a floating card of avatars.
// - Pins are numbered circles, not owner avatars: the photo needs
//   resolve-profile-photo-url and the avatar stack is not ported yet. The
//   single-thread bubble carries the thread seqn, a group carries its count.
// - A pin click does not zoom to the thread and the pins are not draggable:
//   pin moving (update-comment-thread-position with the frame re-anchor and
//   the undo transaction) is a later slice.

import { useSyncExternalStore } from "react";

import {
  groupBubbles,
  sortThreads,
  visibleThreads,
} from "@/lib/workspace-comments";
import { openCommentThread } from "@/lib/workspace-comments-actions";
import {
  getInitialWorkspaceState,
  getWorkspaceState,
  subscribeWorkspace,
} from "@/lib/workspace-store";

// The bubble radius in screen pixels (the CLJS draws a 32px avatar; the
// numbered circle keeps the same footprint).
const BUBBLE_RADIUS = 16;

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
        return (
          <g
            key={first.id}
            className={className}
            data-testid="comment-bubble"
            transform={`translate(${group.position.x} ${group.position.y}) scale(${1 / zoom})`}
          >
            {/* The handle pattern of the overlay: the layer ignores pointer
                events and this circle opts back in (pp-overlay-handle). */}
            <circle
              className="pp-overlay-handle"
              r={BUBBLE_RADIUS}
              onClick={() => void openCommentThread(first.id)}
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
