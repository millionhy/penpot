"use client";

// Thumbnails panel (F6.3). Port of app.main.ui.viewer.thumbnails: the
// summary (frame counter, expand, close), the scrollable strip with its
// arrow handlers and wheel stepping, and the expanded grid of items; an
// item click goes through onSelect (go-to-frame-by-index) and closes the
// panel when it is expanded.
//
// Deviations from the CLJS original, documented:
// - The item preview is a placeholder box with the frame size; the
//   render/frame-svg bitmap (thumbnail data + shapes->rect bounds) arrives
//   with F6.4.
// - The CLJS selected var (compare-and-set! but never read) is dropped.
// - The list width is measured when the panel becomes visible; the CLJS
//   dependency-free effect re-runs every render and reads the same value.
//   A window resize does not re-measure in either version.
// - The panel stays mounted and is hidden with an inline display:none, like
//   the CLJS style (an attribute flip would reflow every item).

import { useEffect, useRef, useState } from "react";
import { ArrowIcon, CloseIcon } from "@/components/viewer-icons";
import { tr } from "@/lib/i18n";
import {
  THUMBNAIL_ITEM_WIDTH,
  stepThumbnailOffset,
  thumbnailWheelDirection,
  type ViewerShape,
} from "@/lib/viewer";

interface ThumbnailItemProps {
  frame: ViewerShape;
  index: number;
  selected: boolean;
  onSelect: (index: number) => void;
}

// thumbnail-item*: the preview box (selected background on the current
// frame) and the name below. The CLJS memoizes and defers the item; with
// placeholder previews there is nothing expensive to defer yet.
function ThumbnailItem({ frame, index, selected, onSelect }: ThumbnailItemProps) {
  const width = Math.round(frame.selrect?.width ?? 0);
  const height = Math.round(frame.selrect?.height ?? 0);
  return (
    <button type="button" className="pp-thumbnail-item" onClick={() => onSelect(index)}>
      <div
        className={
          selected ? "pp-thumbnail-preview pp-thumbnail-preview-selected" : "pp-thumbnail-preview"
        }
      >
        {/* Placeholder until F6.4 renders the frame bitmap. */}
        <span className="pp-thumbnail-size">
          {width + " \u00d7 " + height}
        </span>
      </div>
      <div className="pp-thumbnail-info" title={frame.name}>
        {frame.name}
      </div>
    </button>
  );
}

export interface ViewerThumbnailsProps {
  frames: ViewerShape[];
  index: number;
  show: boolean;
  onSelect: (index: number) => void;
  onClose: () => void;
}

export function ViewerThumbnails({
  frames,
  index,
  show,
  onSelect,
  onClose,
}: ViewerThumbnailsProps) {
  const [expanded, setExpanded] = useState(false);
  const [offset, setOffset] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const widthRef = useRef(0);

  // thumbnails-content* measures the list after layout; the panel opens
  // hidden, so the read happens once it is visible. The bounds use
  // stepThumbnailOffset over this width.
  useEffect(() => {
    if (!show) return;
    const element = listRef.current;
    if (element !== null) widthRef.current = element.clientWidth;
  }, [show, expanded]);

  const step = (direction: "left" | "right") => {
    setOffset((value) => stepThumbnailOffset(value, direction, widthRef.current, frames.length));
  };

  const onItemSelect = (itemIndex: number) => {
    onSelect(itemIndex);
    if (expanded) onClose();
  };

  const items = frames.map((frame, itemIndex) => (
    <ThumbnailItem
      key={frame.id + "-" + itemIndex}
      frame={frame}
      index={itemIndex}
      selected={itemIndex === index}
      onSelect={onItemSelect}
    />
  ));

  return (
    <section
      className={
        expanded ? "pp-viewer-thumbnails pp-thumbnails-expanded" : "pp-viewer-thumbnails"
      }
      style={show ? undefined : { display: "none" }}
    >
      <div className="pp-thumbnails-summary">
        <span className="pp-thumbnails-counter">
          {tr("labels.num-of-frames", frames.length)}
        </span>
        <span className="pp-thumbnails-actions">
          <button
            type="button"
            className="pp-thumbnails-expand"
            onClick={() => setExpanded((value) => !value)}
          >
            <ArrowIcon />
          </button>
          <button type="button" className="pp-thumbnails-dismiss" onClick={onClose}>
            <CloseIcon />
          </button>
        </span>
      </div>
      <div className="pp-thumbnails-content">
        {expanded ? (
          <div className="pp-thumbnails-list-expanded">{items}</div>
        ) : (
          <>
            <button type="button" className="pp-thumbnails-scroll-left" onClick={() => step("left")}>
              <ArrowIcon />
            </button>
            <button
              type="button"
              className="pp-thumbnails-scroll-right"
              onClick={() => step("right")}
            >
              <ArrowIcon />
            </button>
            <div
              ref={listRef}
              className="pp-thumbnails-list"
              onWheel={(event) => step(thumbnailWheelDirection(event.deltaY))}
            >
              <div
                className="pp-thumbnails-list-inside"
                style={{ right: offset * THUMBNAIL_ITEM_WIDTH }}
              >
                {items}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
