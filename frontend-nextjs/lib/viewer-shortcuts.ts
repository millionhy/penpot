// Viewer shortcuts registry (F6.3). Port of the definitions in
// app.main.data.viewer.shortcuts: the 13 shortcuts the viewer mounts under
// the :viewer group (viewer.cljs `hooks/use-shortcuts ::viewer sc/shortcuts
// :viewer`).
//
// Two shell conventions differ from the CLJS shape, like
// lib/dashboard-shortcuts:
// - labelKey holds the i18n key; scripts/extract-translations.mjs scans the
//   labelKey fields, so the catalog keeps these labels exactly like the
//   settings nav does. Do not spell the pattern out in prose here, the
//   regex is not comment-aware.
// - Commands and tooltips are built per platform by viewerShortcuts(macos).
//   The CLJS namespace bakes c-mod/ds/alt at load time (client-only); the
//   shell cannot, because the module also evaluates during SSR.
//
// Deviations from the CLJS original, documented:
// - The registry lists all 13 shortcuts, but three of them are not
//   implemented in the shell yet and bind nothing; see
//   unmigratedViewerShortcuts.
// - The toggle-theme event carries the ::ev/origin "viewer:shortcuts"
//   analytics marker; the shell has no analytics channel yet.

import { aMod, altLabel, cMod, leftArrow, macShift, metaLabel, rightArrow } from "@/lib/shortcuts";

export type ViewerShortcutKey =
  | "increase-zoom"
  | "toggle-theme"
  | "decrease-zoom"
  | "select-all"
  | "reset-zoom"
  | "toggle-zoom-style"
  | "toggle-fullscreen"
  | "prev-frame"
  | "next-frame"
  | "open-inspect"
  | "open-comments"
  | "open-interactions"
  | "open-workspace";

export interface ViewerShortcutDefinition {
  labelKey: string;
  tooltip: string;
  command: string | string[];
  section: readonly string[];
  subsections: readonly string[];
}

export type ViewerShortcuts = Record<ViewerShortcutKey, ViewerShortcutDefinition>;

// The 13 definitions in the CLJS map order; every one carries section
// [:viewer]. zoom-viewer holds the zoom family, navigation-viewer the g-*
// section jumps, generic the frame stepping and the theme toggle.
export function viewerShortcuts(macos: boolean): ViewerShortcuts {
  return {
    "increase-zoom": {
      labelKey: "shortcuts.increase-zoom",
      tooltip: "+",
      command: "+",
      section: ["viewer"],
      subsections: ["zoom-viewer"],
    },
    "toggle-theme": {
      labelKey: "shortcuts.toggle-theme",
      tooltip: altLabel("M", macos),
      command: aMod("m"),
      section: ["viewer"],
      subsections: ["generic"],
    },
    "decrease-zoom": {
      labelKey: "shortcuts.decrease-zoom",
      tooltip: "-",
      command: "-",
      section: ["viewer"],
      subsections: ["zoom-viewer"],
    },
    "select-all": {
      labelKey: "shortcuts.select-all",
      tooltip: metaLabel("A", macos),
      command: cMod("a", macos),
      section: ["viewer"],
      subsections: ["generic"],
    },
    "reset-zoom": {
      labelKey: "shortcuts.reset-zoom",
      tooltip: (macos ? macShift : "Shift+") + "0",
      command: "shift+0",
      section: ["viewer"],
      subsections: ["zoom-viewer"],
    },
    "toggle-zoom-style": {
      labelKey: "shortcuts.toggle-zoom-style",
      tooltip: "F",
      command: "f",
      section: ["viewer"],
      subsections: ["zoom-viewer"],
    },
    "toggle-fullscreen": {
      labelKey: "shortcuts.toggle-fullscreen",
      tooltip: (macos ? macShift : "Shift+") + "F",
      command: ["shift+f", "alt+enter"],
      section: ["viewer"],
      subsections: ["zoom-viewer"],
    },
    "prev-frame": {
      labelKey: "shortcuts.prev-frame",
      tooltip: leftArrow,
      command: ["left", "up", "shift+enter", "pageup", "shift+space"],
      section: ["viewer"],
      subsections: ["generic"],
    },
    "next-frame": {
      labelKey: "shortcuts.next-frame",
      tooltip: rightArrow,
      command: ["right", "down", "enter", "pagedown", "space"],
      section: ["viewer"],
      subsections: ["generic"],
    },
    "open-inspect": {
      labelKey: "shortcuts.open-inspect",
      tooltip: "G I",
      command: "g i",
      section: ["viewer"],
      subsections: ["navigation-viewer"],
    },
    "open-comments": {
      labelKey: "shortcuts.open-comments",
      tooltip: "G C",
      command: "g c",
      section: ["viewer"],
      subsections: ["navigation-viewer"],
    },
    "open-interactions": {
      labelKey: "shortcuts.open-interactions",
      tooltip: "G V",
      command: "g v",
      section: ["viewer"],
      subsections: ["navigation-viewer"],
    },
    "open-workspace": {
      labelKey: "shortcuts.open-workspace",
      tooltip: "G W",
      command: "g w",
      section: ["viewer"],
      subsections: ["navigation-viewer"],
    },
  };
}

// The shortcuts whose consumer the shell does not port yet. They stay in the
// registry (the settings tree lists them, like the CLJS one) but bind
// nothing, so their default commands keep their native browser behaviour:
// select-all feeds the interactions selection (no consumer in the shell),
// open-inspect and open-comments target sections the shell does not render
// (page.tsx falls every section back to interactions).
export const unmigratedViewerShortcuts: readonly ViewerShortcutKey[] = [
  "select-all",
  "open-inspect",
  "open-comments",
];

// What the page provides to run an action: the zoom family, the frame
// stepping, the fullscreen and theme toggles and the two navigation events
// (go-to-section :interactions, go-to-workspace).
export interface ViewerShortcutActions {
  increaseZoom: () => void;
  decreaseZoom: () => void;
  resetZoom: () => void;
  toggleZoomStyle: () => void;
  toggleFullscreen: () => void;
  prevFrame: () => void;
  nextFrame: () => void;
  toggleTheme: () => void;
  goToInteractions: () => void;
  goToWorkspace: () => void;
}

// The dv/* events and page-owned handlers behind each key. The unmigrated
// keys never reach the bindings, but the switch covers them as no-ops so it
// stays total over the key union.
export function runViewerShortcut(key: ViewerShortcutKey, actions: ViewerShortcutActions): void {
  switch (key) {
    case "increase-zoom":
      actions.increaseZoom();
      break;
    case "decrease-zoom":
      actions.decreaseZoom();
      break;
    case "reset-zoom":
      actions.resetZoom();
      break;
    case "toggle-zoom-style":
      actions.toggleZoomStyle();
      break;
    case "toggle-fullscreen":
      actions.toggleFullscreen();
      break;
    case "prev-frame":
      actions.prevFrame();
      break;
    case "next-frame":
      actions.nextFrame();
      break;
    case "toggle-theme":
      actions.toggleTheme();
      break;
    case "open-interactions":
      actions.goToInteractions();
      break;
    case "open-workspace":
      actions.goToWorkspace();
      break;
    case "select-all":
    case "open-inspect":
    case "open-comments":
      break;
  }
}
