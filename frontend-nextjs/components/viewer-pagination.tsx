"use client";

// viewer-pagination of app.main.ui.viewer (F6.2): the prev/next arrows and the
// bottom bar (reset button, frame counter). The CLJS component also has
// left-bar / right-bar / comment-sidebar variants for the embedded contexts;
// the viewer page passes none of them.

import { ArrowIcon, ReloadIcon } from "@/components/viewer-icons";
import { tr } from "@/lib/i18n";

export interface ViewerPaginationProps {
  index: number;
  numFrames: number;
  onPrev: () => void;
  onNext: () => void;
  onFirst: () => void;
}

export function ViewerPagination({ index, numFrames, onPrev, onNext, onFirst }: ViewerPaginationProps) {
  return (
    <>
      {index > 0 ? (
        <button
          type="button"
          className="pp-viewer-go-prev"
          onClick={onPrev}
          aria-label={tr("labels.previous")}
        >
          <ArrowIcon />
        </button>
      ) : null}
      {index + 1 < numFrames ? (
        <button
          type="button"
          className="pp-viewer-go-next"
          onClick={onNext}
          aria-label={tr("labels.next")}
        >
          <ArrowIcon />
        </button>
      ) : null}
      <div className="pp-viewer-bottom">
        <button type="button" onClick={onFirst} className="pp-reset-button">
          <ReloadIcon />
        </button>
        <span className="pp-counter">{`${index + 1} / ${numFrames}`}</span>
        <span />
      </div>
    </>
  );
}
