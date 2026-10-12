"use client";

// Thumbnails panel (F6.3/F6.4). Port of app.main.ui.viewer.thumbnails: the
// summary (frame counter, expand, close), the scrollable strip with its
// arrow handlers and wheel stepping, and the expanded grid of items; an
// item click goes through onSelect (go-to-frame-by-index) and closes the
// panel when it is expanded.
//
// Deviations from the CLJS original, documented:
// - The preview bitmap renders through the shell-side one-shot pass
//   (lib/render-wasm/frame-render, the rebuild of render-to-canvas in
//   app.main.render-viewer-wasm), not the CLJS frame-svg tree: the shell
//   has no SVG shape renderer, and the wasm one is the documented path
//   for thumbnails. The CLJS renders thumbnails lazily per item as the
//   panel opens; so does this one (gated by show).
// - That pass tears down the shared wasm GL context when it finishes
//   (clear-canvas is its last step), so each finished bitmap announces
//   itself on "penpot:wasm:offscreen-render"; the viewport listens and
//   rebuilds (see components/viewer-wasm-viewport).
// - The CLJS selected var (compare-and-set! but never read) is dropped.
// - The list width is measured when the panel becomes visible; the CLJS
//   dependency-free effect re-runs every render and reads the same value.
//   A window resize does not re-measure in either version.
// - The panel stays mounted and is hidden with an inline display:none, like
//   the CLJS style (an attribute flip would reflow every item).

import { useEffect, useRef, useState } from "react";
import { ArrowIcon, CloseIcon } from "@/components/viewer-icons";
import { ensureWasmModule, loadRenderer } from "@/lib/render-wasm/bridge";
import { renderFrameToCanvas } from "@/lib/render-wasm/frame-render";
import { get, keyword, uuid } from "@/lib/render-wasm/interop";
import { calculateSize } from "@/lib/render-wasm/sizes";
import { loadDecodedBundle } from "@/lib/render-wasm/values";
import { tr } from "@/lib/i18n";
import {
  THUMBNAIL_ITEM_WIDTH,
  stepThumbnailOffset,
  thumbnailWheelDirection,
  type ViewerShape,
} from "@/lib/viewer";

// render-to-canvas paints into a canvas whose physical size is
// scale * padded bounds; 264 = 2x the 132px preview box, so the bitmap
// stays crisp on HiDPI screens.
const BITMAP_SIZE_PX = 264;

interface ThumbnailBitmapProps {
  fileId: string;
  shareId: string | null;
  pageId: string;
  frameId: string;
  show: boolean;
}

// The one-shot wasm render of a frame, the port of the object-wasm component
// (render-to-canvas objects canvas bounds scale object-id on-render). The
// canvas starts hidden (CSS keys off data-rendered) and the size span of the
// item stays visible until it paints.
function ThumbnailBitmap({ fileId, shareId, pageId, frameId, show }: ThumbnailBitmapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Monotonic run id: only the newest run drives the canvas (StrictMode
  // replays effects, and a show flip restarts the run).
  const runIdRef = useRef(0);
  // A painted canvas is never re-rendered; the offscreen pass is expensive
  // and tears the shared context down.
  const renderedRef = useRef(false);

  useEffect(() => {
    if (!show || renderedRef.current) return;
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const run = ++runIdRef.current;
    let disposed = false;
    const alive = (): boolean => !disposed && runIdRef.current === run;

    void (async () => {
      try {
        const app = await loadRenderer();
        if (!alive()) return;
        await ensureWasmModule(app);
        if (!alive()) return;

        const bundle = await loadDecodedBundle(app, { fileId, shareId });
        if (!alive()) return;
        const pagesIndex = get(app, bundle.fileData, keyword(app, "pages-index"));
        const page = get(app, pagesIndex, uuid(app, pageId));
        if (page === null || page === undefined) {
          throw new Error(`render-wasm: page ${pageId} not found in the bundle`);
        }
        const objects = get(app, page, keyword(app, "objects"));
        if (objects === null || objects === undefined) {
          throw new Error(`render-wasm: page ${pageId} has no objects`);
        }
        const frame = get(app, objects, uuid(app, frameId));
        if (frame === null || frame === undefined) {
          throw new Error(`render-wasm: frame ${frameId} not on page ${pageId}`);
        }

        // The padded bounds at 1:1 (calculate-size); the canvas physical
        // size keeps the aspect ratio inside the square preview box.
        const size = calculateSize(app, objects, frame, 1);
        const scale = BITMAP_SIZE_PX / Math.max(size.baseWidth, size.baseHeight, 1);
        canvas.width = Math.max(1, Math.round(size.baseWidth * scale));
        canvas.height = Math.max(1, Math.round(size.baseHeight * scale));
        if (!alive()) return;

        // The render is fire-and-forget: the promise settles once the
        // bitmap landed on the canvas (and the shared context was torn
        // down). Both state writes are unconditional: the runs race on a
        // canvas that stays mounted, and the last paint is the truth.
        void renderFrameToCanvas(app, objects, frameId, canvas, { x: size.x, y: size.y }, scale)
          .then(() => {
            canvas.dataset.rendered = "true";
            renderedRef.current = true;
            document.dispatchEvent(
              new CustomEvent("penpot:wasm:offscreen-render", { detail: { frameId } }),
            );
          })
          .catch((cause: unknown) => {
            console.error("[render-wasm] thumbnail render failed:", cause);
            canvas.dataset.rendered = "error";
          });
      } catch (cause: unknown) {
        if (!alive()) return;
        console.error("[render-wasm] thumbnail render failed:", cause);
        canvas.dataset.rendered = "error";
      }
    })();

    return () => {
      disposed = true;
    };
  }, [show, fileId, shareId, pageId, frameId]);

  return <canvas ref={canvasRef} className="pp-thumbnail-canvas" data-rendered="false" />;
}

interface ThumbnailItemProps {
  frame: ViewerShape;
  index: number;
  selected: boolean;
  onSelect: (index: number) => void;
  fileId: string;
  shareId: string | null;
  pageId: string;
  show: boolean;
}

// thumbnail-item*: the preview box (selected background on the current
// frame) and the name below. The CLJS memoizes and defers the item; here
// the bitmap render is gated by show (the panel stays mounted while
// closed), so a closed panel costs nothing.
function ThumbnailItem({
  frame,
  index,
  selected,
  onSelect,
  fileId,
  shareId,
  pageId,
  show,
}: ThumbnailItemProps) {
  const width = Math.round(frame.selrect?.width ?? 0);
  const height = Math.round(frame.selrect?.height ?? 0);
  return (
    <button type="button" className="pp-thumbnail-item" onClick={() => onSelect(index)}>
      <div
        className={
          selected ? "pp-thumbnail-preview pp-thumbnail-preview-selected" : "pp-thumbnail-preview"
        }
      >
        <ThumbnailBitmap
          fileId={fileId}
          shareId={shareId}
          pageId={pageId}
          frameId={frame.id}
          show={show}
        />
        {/* The size stays as the placeholder until the bitmap paints. */}
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
  fileId: string;
  shareId: string | null;
  pageId: string;
}

export function ViewerThumbnails({
  frames,
  index,
  show,
  onSelect,
  onClose,
  fileId,
  shareId,
  pageId,
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
      fileId={fileId}
      shareId={shareId}
      pageId={pageId}
      show={show}
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
