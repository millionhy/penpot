"use client";

// One open overlay of the wasm viewer (F6.5), the port of viewer.cljs
// viewer-overlay: a nested frame displayed above the current one, aligned
// by the snap-to of the interaction.
//
// The component renders two siblings per overlay, like the CLJS [:*]:
// - the click-outside / dimming layer, rendered for close-click-outside or
//   background-overlay and visible (dimmed) for the latter; a click closes
//   the overlay, with the inverted animation for f65f;
// - the overlay container carrying a nested ViewerWasmViewport, positioned
//   by the overlay position times the zoom. A fixed-source overlay pins
//   the container to the viewport instead (the CSS positioning is ported;
//   the fixed-scroll layer of the nested viewport is a later slice).
//
// Deviations from the CLJS original, documented:
// - The container size comes from the renderer's onBounds report (the
//   padded bounds), with the frame selrect as the stand-in until the first
//   report; the CLJS calculates the size up front from the decoded page.
// - The CLJS looks the overlay frame up in the global all-frames; the
//   caller resolves it on the current page and passes its name / selrect.

import { useCallback, useState } from "react";

import {
  ViewerWasmViewport,
  type ViewerWasmBounds,
} from "@/components/viewer-wasm-viewport";
import { invertDirection, type OverlaySpec, type ViewerAction } from "@/lib/viewer-interactions";
import type { ViewerShape } from "@/lib/viewer";

interface ViewerOverlayProps {
  overlay: OverlaySpec;
  fileId: string;
  shareId: string | null;
  pageId: string;
  // The top-level frame that carries this overlay (the base frame of the
  // interaction math).
  baseFrameId: string;
  // The overlay frame's name and selrect, from page.allFrames.
  frameName: string;
  frameSelrect: ViewerShape["selrect"];
  zoom: number;
  // The viewer wrapper size: the backdrop spans it (viewer.cljs
  // wrapper-size).
  wrapperWidth: number;
  wrapperHeight: number;
  // refs/viewer-overlays: the frame ids of every open overlay.
  overlaysIds: readonly string[];
  onAction: (action: ViewerAction) => void;
}

export function ViewerOverlay({
  overlay,
  fileId,
  shareId,
  pageId,
  baseFrameId,
  frameName,
  frameSelrect,
  zoom,
  wrapperWidth,
  wrapperHeight,
  overlaysIds,
  onAction,
}: ViewerOverlayProps) {
  // The padded bounds of the overlay frame, reported by the nested
  // viewport; the selrect stands in until the first report.
  const [bounds, setBounds] = useState<ViewerWasmBounds | null>(null);

  const handleBounds = useCallback((next: ViewerWasmBounds | null) => {
    setBounds(next);
  }, []);

  // The viewer-overlay on-click: only close-click-outside reacts, with the
  // inverted animation of the overlay (ctsi/invert-direction).
  const onBackgroundClick = () => {
    if (overlay.closeClickOutside !== true) return;
    onAction({
      kind: "close-overlay",
      frameId: overlay.frameId,
      animation: invertDirection(overlay.animation),
    });
  };

  const width = (bounds?.baseWidth ?? frameSelrect?.width ?? 0) * zoom;
  const height = (bounds?.baseHeight ?? frameSelrect?.height ?? 0) * zoom;

  const viewport = (
    <ViewerWasmViewport
      fileId={fileId}
      shareId={shareId}
      pageId={pageId}
      frameId={overlay.frameId}
      frameName={frameName}
      zoom={zoom}
      onBounds={handleBounds}
      snapTo={overlay.snapTo}
      frameOffset={overlay.position}
      baseFrameId={baseFrameId}
      overlaysIds={overlaysIds}
      onAction={onAction}
    />
  );

  return (
    <>
      {overlay.closeClickOutside === true || overlay.backgroundOverlay === true ? (
        <div
          className={
            overlay.backgroundOverlay === true
              ? "pp-viewer-overlay-background pp-visible"
              : "pp-viewer-overlay-background"
          }
          style={{
            width: wrapperWidth,
            height: wrapperHeight,
            position: "absolute",
            left: 0,
            top: 0,
          }}
          onClick={onBackgroundClick}
        />
      ) : null}
      {overlay.fixedSource === true ? (
        <div
          className="pp-viewport-container-wrapper"
          style={{
            position: "absolute",
            left: overlay.position.x * zoom,
            top: overlay.position.y * zoom,
            width,
            height,
            zIndex: 2,
          }}
        >
          <div
            className="pp-viewer-overlay pp-viewport-container"
            id={"overlay-" + overlay.frameId}
            style={{ width, height, position: "fixed" }}
          >
            {viewport}
          </div>
        </div>
      ) : (
        <div
          className="pp-viewer-overlay pp-viewport-container"
          id={"overlay-" + overlay.frameId}
          style={{
            width,
            height,
            left: overlay.position.x * zoom,
            top: overlay.position.y * zoom,
          }}
        >
          {viewport}
        </div>
      )}
    </>
  );
}
