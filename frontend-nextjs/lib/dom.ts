// Small DOM helpers shared by the migrated pages.

import { useEffect } from "react";

// dom/set-html-title in app.util.dom. The CLJS pages call it from
// mf/with-effect on mount; the shell pages are client components, so a hook
// keeps the same shape and updates on a locale change.
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    // The empty string means "leave the title alone": CLJS pages only call
    // dom/set-html-title once their data resolved (files-section* waits for
    // the project), and rendering nothing must not blank the tab title.
    if (title === "") return;
    document.title = title;
  }, [title]);
}

// dom/trigger-download in app.util.dom: an object URL on a synthetic anchor,
// revoked right after the click.
export function triggerDownload(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.download = filename;
  anchor.href = url;
  anchor.click();
  URL.revokeObjectURL(url);
}

// cm/mtype->extension (common/src/app/common/media.cljc), limited to the types
// the shell downloads today.
const mtypeExtensions: Record<string, string> = {
  "application/penpot": ".penpot",
};

// dom/trigger-download-uri in app.util.dom: a direct URI download through a
// synthetic anchor. The canonical extension of the mtype is appended when the
// filename lacks it, which is what turns "My file" into "My file.penpot".
export function triggerDownloadUri(filename: string, mtype: string, uri: string): void {
  const extension = mtypeExtensions[mtype];
  const name =
    extension !== undefined && !filename.endsWith(extension) ? filename + extension : filename;
  const link = document.createElement("a");
  link.href = uri;
  link.download = name;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export interface PickFilesOptions {
  accept: string;
  multiple?: boolean;
}

// The file-uploader* component of the CLJS importer, as a one-shot helper:
// the import entry points that have no mounted input (the project menu
// unmounts its content while it closes, see the note in
// frontend/src/app/main/ui/dashboard/project_menu.cljs) pick through a
// transient input appended to the body. Resolves with null when the picker
// is cancelled or its "cancel" event never fires (the input is then simply
// left detached; there is no such state to wait on).
export function pickFiles(options: PickFilesOptions): Promise<File[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = options.accept;
    input.multiple = options.multiple === true;
    input.style.display = "none";
    document.body.appendChild(input);
    const settle = (files: File[] | null) => {
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", () => {
      settle(input.files === null ? null : [...input.files]);
    });
    input.addEventListener("cancel", () => settle(null));
    input.click();
  });
}

// Port of app.util.dom.normalize-wheel (itself adapted from the Facebook
// fixed-data-table helper): legacy events report wheel deltas in lines
// (event.detail) or with an inverted sign (event.wheelDelta*), so this folds
// them into a "spin" count where one wheel step is 1. Only the spin values
// are kept (the templates strip scroll handler is the sole consumer; the
// pixelX/pixelY outputs have no callers) and the DOMMouseScroll axis branch
// is dropped with its Gecko-era event.

const PIXEL_STEP = 10;
const LINE_HEIGHT = 40;
const PAGE_HEIGHT = 800;

export interface WheelSpin {
  spinX: number;
  spinY: number;
}

// The wheelDelta* properties live outside the standard WheelEvent type.
interface LegacyWheelAdditions {
  wheelDelta?: number;
  wheelDeltaX?: number;
  wheelDeltaY?: number;
}

export function normalizeWheel(event: WheelEvent): WheelSpin {
  const legacy = event as WheelEvent & LegacyWheelAdditions;
  let spinX = 0;
  let spinY = 0;

  // UIEvent.detail carried the line count on old Gecko engines; modern
  // browsers report 0 here and fill wheelDelta* instead, both optional.
  if ("detail" in event) spinY = event.detail;
  if (typeof legacy.wheelDelta === "number") spinY = -legacy.wheelDelta / 120;
  if (typeof legacy.wheelDeltaY === "number") spinY = -legacy.wheelDeltaY / 120;
  if (typeof legacy.wheelDeltaX === "number") spinX = -legacy.wheelDeltaX / 120;

  let pixelX = spinX * PIXEL_STEP;
  let pixelY = spinY * PIXEL_STEP;

  if ("deltaY" in event) pixelY = event.deltaY;
  if ("deltaX" in event) pixelX = event.deltaX;

  if ((pixelX !== 0 || pixelY !== 0) && event.deltaMode !== 0) {
    if (event.deltaMode === 1) {
      pixelX *= LINE_HEIGHT;
      pixelY *= LINE_HEIGHT;
    } else {
      pixelX *= PAGE_HEIGHT;
      pixelY *= PAGE_HEIGHT;
    }
  }

  // Fall-back if the spin cannot be determined.
  if (pixelX !== 0 && spinX === 0) spinX = pixelX < 1 ? -1 : 1;
  if (pixelY !== 0 && spinY === 0) spinY = pixelY < 1 ? -1 : 1;

  return { spinX, spinY };
}
