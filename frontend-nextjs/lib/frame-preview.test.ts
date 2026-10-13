import { describe, expect, it } from "vitest";
import {
  previewZoom,
  writePreviewContent,
  writePreviewDocument,
  type PreviewDocument,
  type PreviewIframe,
} from "@/lib/frame-preview";

// handle-load in frame_preview.cljs sizes the iframe and then writes the
// generated document. The mock records the document calls in order.
function mockIframe(): PreviewIframe & { calls: string[] } {
  const calls: string[] = [];
  const document: PreviewDocument = {
    open: () => {
      calls.push("open");
    },
    write: (data) => {
      calls.push(`write:${data}`);
    },
    close: () => {
      calls.push("close");
    },
  };
  return { width: 0, height: 0, contentWindow: { document }, calls };
}

describe("writePreviewDocument", () => {
  it("sizes the iframe 64px past the content", () => {
    const iframe = mockIframe();
    writePreviewDocument(iframe, "<html></html>", 100, 50);
    expect(iframe.width).toBe(164);
    expect(iframe.height).toBe(114);
  });

  it("opens, writes and closes the content document", () => {
    const iframe = mockIframe();
    writePreviewDocument(iframe, "<html></html>", 100, 50);
    expect(iframe.calls).toEqual(["open", "write:<html></html>", "close"]);
  });
});

describe("writePreviewContent", () => {
  it("writes without touching the iframe size", () => {
    const iframe = mockIframe();
    iframe.width = 164;
    iframe.height = 114;
    writePreviewContent(iframe, "second");
    expect(iframe.calls).toEqual(["open", "write:second", "close"]);
    expect(iframe.width).toBe(164);
    expect(iframe.height).toBe(114);
  });

  it("stays quiet when the iframe has no content window", () => {
    const iframe: PreviewIframe = { width: 0, height: 0, contentWindow: null };
    expect(() => writePreviewContent(iframe, "data")).not.toThrow();
  });
});

// change-zoom in frame_preview.cljs: parse-integer over 100.
describe("previewZoom", () => {
  it("maps the range value to a scale factor", () => {
    expect(previewZoom("100")).toBe(1);
    expect(previewZoom("400")).toBe(4);
    expect(previewZoom("1")).toBe(0.01);
  });

  it("keeps the default zoom for an unparsable value", () => {
    expect(previewZoom("abc")).toBe(1);
    expect(previewZoom("")).toBe(1);
  });
});
