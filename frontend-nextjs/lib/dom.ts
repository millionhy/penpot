// Small DOM helpers shared by the migrated pages.

import { useEffect } from "react";

// dom/set-html-title in app.util.dom. The CLJS pages call it from
// mf/with-effect on mount; the shell pages are client components, so a hook
// keeps the same shape and updates on a locale change.
export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}
