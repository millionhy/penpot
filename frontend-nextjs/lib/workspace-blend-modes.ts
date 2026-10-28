// The layer blend modes of the workspace style panel (F9.14).
//
// Ported from frontend/src/app/main/ui/workspace/sidebar/options/menus/
// layer.cljs: the :blend-mode select lists these sixteen values in this
// order, and a shape without the attribute reads as :normal.
//
// The value is the stored keyword name (the backend schema keyword). The
// label is a `labelKey` field so scripts/extract-translations.mjs sees the
// key and the catalog carries it (a tr(`...${mode}`) call site would not).

import type { WorkspaceShape } from "@/lib/workspace";

export interface BlendMode {
  value: string;
  labelKey: string;
}

export const BLEND_MODES: readonly BlendMode[] = [
  { value: "normal", labelKey: "workspace.options.layer-options.blend-mode.normal" },
  { value: "darken", labelKey: "workspace.options.layer-options.blend-mode.darken" },
  { value: "multiply", labelKey: "workspace.options.layer-options.blend-mode.multiply" },
  { value: "color-burn", labelKey: "workspace.options.layer-options.blend-mode.color-burn" },
  { value: "lighten", labelKey: "workspace.options.layer-options.blend-mode.lighten" },
  { value: "screen", labelKey: "workspace.options.layer-options.blend-mode.screen" },
  { value: "color-dodge", labelKey: "workspace.options.layer-options.blend-mode.color-dodge" },
  { value: "overlay", labelKey: "workspace.options.layer-options.blend-mode.overlay" },
  { value: "soft-light", labelKey: "workspace.options.layer-options.blend-mode.soft-light" },
  { value: "hard-light", labelKey: "workspace.options.layer-options.blend-mode.hard-light" },
  { value: "difference", labelKey: "workspace.options.layer-options.blend-mode.difference" },
  { value: "exclusion", labelKey: "workspace.options.layer-options.blend-mode.exclusion" },
  { value: "hue", labelKey: "workspace.options.layer-options.blend-mode.hue" },
  { value: "saturation", labelKey: "workspace.options.layer-options.blend-mode.saturation" },
  { value: "color", labelKey: "workspace.options.layer-options.blend-mode.color" },
  { value: "luminosity", labelKey: "workspace.options.layer-options.blend-mode.luminosity" },
];

// The stored blend mode of a shape; a missing or non-string value is normal.
export function blendModeOf(shape: WorkspaceShape): string {
  const value = shape["blend-mode"];
  return typeof value === "string" ? value : "normal";
}
