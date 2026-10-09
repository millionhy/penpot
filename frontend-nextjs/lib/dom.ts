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
