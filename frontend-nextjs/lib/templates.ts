// Templates strip (F5.6). Headless parts of the dashboard templates section
// (app.main.ui.dashboard.templates): the builtin-template list filtering, the
// card thumbnail URL and the persisted collapsed flag.
//
// Deviations from the CLJS original, documented:
// - templateThumbnailUrl is the u/join of cf/public-uri with
//   "images/thumbnails/template-<id>.jpg" that card-item* builds inline.
// - The collapsed flag: ::collapsed lives in storage/global under the
//   namespace of the view; lib/storage.ts is the shell mapping of that store.

import type { BuiltinTemplate } from "./binfile";
import { globalStorage } from "./storage";

// The onboarding templates templates-section* filters out of the strip
// (welcome and the beginner tutorial open only from the onboarding flows).
const HIDDEN_TEMPLATE_IDS = ["welcome", "tutorial-for-beginners"];

export function visibleTemplates(rows: BuiltinTemplate[]): BuiltinTemplate[] {
  return rows.filter((row) => !HIDDEN_TEMPLATE_IDS.includes(row.id));
}

// u/join semantics for the two-part case in play: joined with "/" and the
// public uri's own trailing slash never doubled.
export function templateThumbnailUrl(publicUri: string, templateId: string): string {
  const base = publicUri.endsWith("/") ? publicUri : publicUri + "/";
  return base + "images/thumbnails/template-" + templateId + ".jpg";
}

// Namespace and key of ::collapsed in app.main.ui.dashboard.templates, in the
// same "penpot-global" store the CLJS island writes.
export const TEMPLATES_STORAGE_NS = "app.main.ui.dashboard.templates";
export const TEMPLATES_STORAGE_KEY = "collapsed";

// A missing entry means expanded, so only an explicit boolean true collapses.
export function readTemplatesCollapsed(): boolean {
  return globalStorage.get<unknown>(TEMPLATES_STORAGE_NS, TEMPLATES_STORAGE_KEY) === true;
}

export function writeTemplatesCollapsed(collapsed: boolean): void {
  globalStorage.set(TEMPLATES_STORAGE_NS, TEMPLATES_STORAGE_KEY, collapsed);
}
