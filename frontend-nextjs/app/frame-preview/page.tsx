"use client";

// Port of app.main.ui.frame-preview, the popup of the workspace preview
// generator: the opener hands the generated HTML over through
// window.load(data, width, height) (update-preview-window in
// data/preview.cljs), the page writes it into an iframe and scales it with
// the zoom range input.
//
// window.load here is a plain property of the window the opener calls once
// it shows up, not the load event; the CLJS assigns it the same way
// (aset on mount, js-delete on unmount).
//
// The App Router path is /frame-preview where the CLJS serves the page
// from the hash route /#/frame-preview; a future workspace port opens this
// path.

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import {
  previewZoom,
  writePreviewContent,
  writePreviewDocument,
  type PreviewLoad,
} from "@/lib/frame-preview";

// The cross-window hook the opener calls; it is not part of Window.
type FramePreviewWindow = Window & { load?: PreviewLoad };

export default function FramePreviewPage() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const lastDataRef = useRef<string | null>(null);
  const [zoom, setZoom] = useState(1);

  // handle-load in frame_preview.cljs: remember the payload, size the
  // iframe 64px past the content and write the document.
  const handleLoad = useCallback<PreviewLoad>((data, width, height) => {
    lastDataRef.current = data;
    const iframe = iframeRef.current;
    if (iframe === null) return;
    writePreviewDocument(iframe, data, width, height);
  }, []);

  // load-ref in frame_preview.cljs: a payload that arrived before the ref
  // attached is written here, without touching the iframe size.
  const loadRef = useCallback((iframe: HTMLIFrameElement | null) => {
    iframeRef.current = iframe;
    const lastData = lastDataRef.current;
    if (iframe !== null && lastData !== null) {
      writePreviewContent(iframe, lastData);
    }
  }, []);

  useEffect(() => {
    const frameWindow = window as FramePreviewWindow;
    frameWindow.load = handleLoad;
    return () => {
      delete frameWindow.load;
    };
  }, [handleLoad]);

  const changeZoom = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setZoom(previewZoom(event.target.value));
  }, []);

  return (
    <div
      style={{
        display: "flex",
        width: "100%",
        height: "100vh",
        flexDirection: "column",
        overflow: "auto",
        alignItems: "center",
      }}
    >
      <input
        id="zoom-input"
        type="range"
        min={1}
        max={400}
        defaultValue={100}
        onChange={changeZoom}
        style={{ maxWidth: "500px" }}
      />
      <div style={{ width: "100%", height: "100%", overflow: "auto" }}>
        <iframe
          ref={loadRef}
          title="Frame preview"
          frameBorder="0"
          scrolling="no"
          style={{ transformOrigin: "top left", transform: `scale(${zoom})` }}
        />
      </div>
    </div>
  );
}
