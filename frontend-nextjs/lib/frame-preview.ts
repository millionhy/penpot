// Port of app.main.ui.frame-preview (the /frame-preview route): the popup
// the workspace preview generator opens. The opener hands the generated
// HTML over through window.load(data, width, height)
// (update-preview-window in data/preview.cljs calls preview.load); the page
// writes it into an iframe and scales it with the zoom range input.

// The iframe surface used below: a real HTMLIFrameElement narrows to this
// (its width/height IDL attributes are strings, and the CLJS aset writes
// numbers the browser stringifies), and the unit tests pass a plain mock.
export interface PreviewIframe {
  width: number | string;
  height: number | string;
  contentWindow: { document: PreviewDocument } | null;
}

export interface PreviewDocument {
  open(): void;
  write(data: string): void;
  close(): void;
}

// The window.load contract of frame_preview.cljs (handle-load).
export type PreviewLoad = (data: string, width: number, height: number) => void;

function previewDocument(iframe: PreviewIframe): PreviewDocument | null {
  const window = iframe.contentWindow;
  if (window === null || window === undefined) return null;
  return window.document;
}

// handle-load in frame_preview.cljs: the iframe is sized 64px past the
// content before the document is written.
export function writePreviewDocument(
  iframe: PreviewIframe,
  data: string,
  width: number,
  height: number,
): void {
  iframe.width = width + 64;
  iframe.height = height + 64;
  writePreviewContent(iframe, data);
}

// The document write shared by handle-load and load-ref (the CLJS repeats
// the open/write/close chain; load-ref skips the sizing).
export function writePreviewContent(iframe: PreviewIframe, data: string): void {
  const doc = previewDocument(iframe);
  if (doc === null) return;
  doc.open();
  doc.write(data);
  doc.close();
}

// change-zoom in frame_preview.cljs: parse-integer over 100. A value that
// does not parse keeps the default zoom of 1, where the CLJS would divide
// a nil (the range input always carries a number in practice).
export function previewZoom(value: string): number {
  const level = Number.parseInt(value, 10);
  return Number.isNaN(level) ? 1 : level / 100;
}
