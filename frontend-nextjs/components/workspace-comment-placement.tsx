"use client";

// The canvas click-to-place flow for comments (F5.7 follow-up slice): the
// role of the :comments drawing tool of the CLJS workspace — while the
// placement runs this layer covers the canvas (the same full-viewport
// rect the marquee handle pattern uses), the next pointer press maps the
// client point into the world vbox (clientPointToWorld, the inverse of the
// svg viewBox) and a floating composer at that point edits the draft before
// the thread is created there (anchored with frameIdForPosition, like the
// CLJS create-draft + add-comment flow).

import { useState, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";

import { tr } from "@/lib/i18n";
import { clientPointToWorld, validCommentContent } from "@/lib/workspace-comments";
import {
  cancelCommentPlacement,
  createThreadAtPlacement,
  setPlacementPoint,
} from "@/lib/workspace-comments-actions";
import {
  getInitialWorkspaceState,
  getWorkspaceState,
  subscribeWorkspace,
} from "@/lib/workspace-store";

// The composer card size in screen pixels inside the foreignObject.
const COMPOSER_WIDTH = 300;
const COMPOSER_HEIGHT = 170;

export function WorkspaceCommentPlacement() {
  const state = useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceState,
    getInitialWorkspaceState,
  );
  const placing = state.comments.placing;
  const placementPoint = state.comments.placementPoint;
  const vbox = state.vbox;
  const zoom = state.zoom ?? 1;

  const [draft, setDraft] = useState("");

  if (!placing || vbox === null) return null;

  // Any press on the catcher picks (or moves) the point: the canvas gestures
  // below never see it while the placement runs, like the CLJS tool mode.
  const pick = (event: ReactPointerEvent<SVGRectElement>): void => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPlacementPoint(
      clientPointToWorld(
        { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
        vbox,
        event.clientX,
        event.clientY,
      ),
    );
  };

  const submit = (): void => {
    if (!validCommentContent(draft)) return;
    setDraft("");
    void createThreadAtPlacement(draft);
  };

  return (
    <g className="pp-comment-placement" data-testid="comment-placement">
      <rect
        className="pp-overlay-handle pp-comment-placement-catcher"
        data-testid="comment-placement-catcher"
        x={vbox.x}
        y={vbox.y}
        width={vbox.width}
        height={vbox.height}
        onPointerDown={pick}
      />
      {placementPoint !== null ? (
        <g
          transform={`translate(${placementPoint.x} ${placementPoint.y}) scale(${1 / zoom})`}
        >
          <circle className="pp-comment-placement-dot" r={6} />
          <foreignObject x={12} y={-COMPOSER_HEIGHT / 2} width={COMPOSER_WIDTH} height={COMPOSER_HEIGHT}>
            <div className="pp-comment-placement-card" data-testid="comment-placement-card">
              <textarea
                className="pp-comments-input"
                rows={3}
                autoFocus
                value={draft}
                placeholder={tr("labels.write-new-comment")}
                aria-label={tr("labels.write-new-comment")}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setDraft("");
                    cancelCommentPlacement();
                  }
                }}
              />
              <div className="pp-comment-placement-actions">
                <button
                  type="button"
                  className="pp-comments-back"
                  onClick={() => {
                    setDraft("");
                    cancelCommentPlacement();
                  }}
                >
                  {tr("labels.close")}
                </button>
                <button
                  type="button"
                  className="pp-comments-submit"
                  disabled={!validCommentContent(draft)}
                  onClick={submit}
                >
                  {tr("labels.comment")}
                </button>
              </div>
            </div>
          </foreignObject>
        </g>
      ) : null}
    </g>
  );
}
