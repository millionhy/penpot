"use client";

// The viewer comments layer (F6.6/D22): the port of comments-layer of
// app.main.ui.viewer.comments. It sits over the frame viewport while the
// viewer shows the comments section: the pins of the shown frame, the
// click-to-place composer and the click rules of the CLJS layer.
//
// The layer draws in world units. The viewBox is the padded frame box the
// renderer reports (0 0 baseWidth baseHeight), the container is that box at
// the zoom, so one unit is `zoom` screen pixels; a group translates the
// world origin to the box origin, exactly like the prepared hotspot layer
// (lib/render-wasm/viewer-shapes). The pins scale by 1/zoom inside the
// group, so they keep one screen size.
//
// Deviations from the CLJS original, documented:
// - A click on empty canvas collapses a temporarily expanded pin cluster in
//   the CLJS; the shell has no expanded cluster state (the grouped pin opens
//   a floating card instead), so there is nothing to collapse.
// - The draft anchors to the frame the viewer shows (the CLJS create-draft
//   passes the frame id; lib/workspace-comments-actions would otherwise pick
//   the deepest frame under the point).
// - The layer covers the frame box, not the whole wrapper: the two are equal
//   except during a navigation animation, and the frame box keeps the clicks
//   off the leaving viewport.

import {
  useRef,
  useSyncExternalStore,
  type MouseEvent,
} from "react";

import { WorkspaceCommentBubbles } from "@/components/workspace-comment-bubbles";
import { WorkspaceCommentPlacement } from "@/components/workspace-comment-placement";
import type { ViewerWasmBounds } from "@/components/viewer-wasm-viewport";
import { clientPointToWorld } from "@/lib/workspace-comments";
import {
  closeCommentThread,
  setPlacementPoint,
  startCommentPlacement,
} from "@/lib/workspace-comments-actions";
import {
  getInitialWorkspaceState,
  getWorkspaceState,
  subscribeWorkspace,
} from "@/lib/workspace-store";

export interface ViewerCommentsLayerProps {
  // The open page and the frame the viewer shows: the pins of other frames
  // stay out, like the frame-id filter of the CLJS.
  pageId: string;
  frameId: string;
  // The zoom of the viewport: one viewBox unit is this many screen pixels.
  zoom: number;
  // The padded frame box in world coordinates, as the renderer reported it.
  bounds: ViewerWasmBounds;
}

export function ViewerCommentsLayer({
  pageId,
  frameId,
  zoom,
  bounds,
}: ViewerCommentsLayerProps) {
  const state = useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceState,
    getInitialWorkspaceState,
  );
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // The click order of the CLJS on-click: while placing, the catcher owns the
  // press; an open thread closes; otherwise the point starts a draft.
  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    if (
      target !== null &&
      target.closest("[data-testid='comment-bubble'], [data-testid='comment-placement']") !== null
    ) {
      return;
    }
    if (state.comments.placing) return;
    if (state.comments.openThreadId !== null) {
      closeCommentThread();
      return;
    }

    const wrapper = wrapperRef.current;
    if (wrapper === null) return;
    const rect = wrapper.getBoundingClientRect();
    const point = clientPointToWorld(
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      { x: bounds.x, y: bounds.y, width: bounds.baseWidth, height: bounds.baseHeight },
      event.clientX,
      event.clientY,
    );
    startCommentPlacement();
    setPlacementPoint(point);
  };

  return (
    <div
      ref={wrapperRef}
      className="pp-viewer-comments-layer"
      data-testid="viewer-comments-layer"
      onClick={handleClick}
    >
      <svg
        viewBox={"0 0 " + bounds.baseWidth + " " + bounds.baseHeight}
        width="100%"
        height="100%"
      >
        <g transform={"translate(" + -bounds.x + " " + -bounds.y + ")"}>
          <WorkspaceCommentBubbles pageId={pageId} frameId={frameId} zoom={zoom} />
          <WorkspaceCommentPlacement frameId={frameId} />
        </g>
      </svg>
    </div>
  );
}
