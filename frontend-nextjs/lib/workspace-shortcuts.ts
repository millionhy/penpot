// Workspace shortcuts registry (D20). Port of the definitions in
// app.main.data.workspace.shortcuts (base-shortcuts, opacity-shortcuts and
// the text-editor set of app.main.data.workspace.text.shortcuts) and
// app.main.data.workspace.path.shortcuts, i.e. the maps the settings page
// merges into the workspace section of its tree
// (build-all-shortcuts-without-basics in app.main.ui.shortcuts).
//
// Two shell conventions differ from the CLJS shape, like
// lib/dashboard-shortcuts:
// - labelKey holds the i18n key; scripts/extract-translations.mjs scans the
//   labelKey fields, so the catalog keeps these labels exactly like the
//   settings nav does. Do not spell the pattern out in prose here, the
//   regex is not comment-aware.
// - Commands are built per platform by workspaceShortcuts(macos) and
//   pathShortcuts(macos). The CLJS namespace bakes c-mod/a-mod at load time
//   (client-only); the shell cannot, because the module also evaluates
//   during SSR.
//
// Scope: the settings page needs the labels, the default commands and the
// section/subsection placement, so this module carries only those. The
// handlers (:fn) stay with the workspace pages that own the behaviour, and
// the tooltips are not ported: no shell surface reads them for this
// context yet.
//
// Deviations from the CLJS original, documented:
// - The "basics" subsection is dropped, like the page builder, which
//   dissocs :basics and renders the without-basics tree; the shared
//   toggle-theme/plugins rows live under :generic there.
// - debug-shortcuts (preview-frame) is a *assert*-only entry of the CLJS
//   dev builds; the shell keeps the release registry.
// - The path registry keeps its own map: the CLJS page merges it into the
//   workspace one per subsection, so five keys (copy, cut, paste,
//   duplicate, select-all) appear twice, once under :edit or :main-menu and
//   once under :path-editor. A single Record cannot hold both rows, so the
//   page concatenates the entries of the two maps.
// - :overwrite only matters when the sets are mounted together at runtime;
//   the settings tree lists each row either way.

import { aMod, cMod } from "@/lib/shortcuts";

export interface WorkspaceShortcutDefinition {
  labelKey: string;
  command: string | string[];
  section: readonly string[];
  subsections: readonly string[];
  customizable: boolean;
}

export type WorkspaceShortcuts = Record<string, WorkspaceShortcutDefinition>;

interface DefinitionOptions {
  section?: readonly string[];
  customizable?: boolean;
}

// The four map lookups share one shape: a label key, the command as the
// CLJS helpers spell it, and the subsections the row belongs to. The
// workspace section is the default; the basic rows still name it so the
// data matches the CLJS maps.
function def(
  labelKey: string,
  command: string | string[],
  subsections: readonly string[],
  options: DefinitionOptions = {},
): WorkspaceShortcutDefinition {
  return {
    labelKey,
    command,
    section: options.section ?? ["workspace"],
    subsections,
    customizable: options.customizable !== false,
  };
}

// workspace/shortcuts.cljs merged as (merge base-shortcuts opacity-shortcuts
// text.shortcuts/shortcuts), the release-set shape.
export function workspaceShortcuts(macos: boolean): WorkspaceShortcuts {
  return {

    // --- base-shortcuts --------------------------------------------
    "undo": def("shortcuts.undo", cMod("z", macos), ["edit"]),
    "redo": def("shortcuts.redo", [cMod("shift+z", macos), cMod("y", macos)], ["edit"]),
    "clear-undo": def("shortcuts.clear-undo", "alt+q", ["edit"]),
    "copy": def("shortcuts.copy", cMod("c", macos), ["edit"]),
    "copy-link": def("shortcuts.copy-link", "shift+alt+c", ["edit"]),
    "cut": def("shortcuts.cut", cMod("x", macos), ["edit"]),
    "paste": def("shortcuts.paste", cMod("v", macos), ["edit"], { customizable: false }),
    "paste-replace": def("shortcuts.paste-replace", cMod("shift+v", macos), ["edit"]),
    "copy-props": def("shortcuts.copy-props", cMod("alt+c", macos), ["edit"]),
    "paste-props": def("shortcuts.paste-props", cMod("alt+v", macos), ["edit"]),
    "delete": def("shortcuts.delete", ["del", "backspace"], ["edit"]),
    "duplicate": def("shortcuts.duplicate", cMod("d", macos), ["edit"]),
    "start-editing": def("shortcuts.start-editing", "enter", ["edit"]),
    "show-measure": def("shortcuts.show-measure", ["alt", "."], ["tools"]),
    "escape": def("shortcuts.escape", "escape", ["edit"]),
    "find": def("shortcuts.find", cMod("f", macos), ["edit"]),
    "find-and-replace": def("shortcuts.find-and-replace", cMod("h", macos), ["edit"]),
    "rename": def("shortcuts.rename", "alt+n", ["edit"]),
    "group": def("shortcuts.group", cMod("g", macos), ["modify-layers"]),
    "ungroup": def("shortcuts.ungroup", "shift+g", ["modify-layers"]),
    "mask": def("shortcuts.mask", cMod("m", macos), ["modify-layers"]),
    "unmask": def("shortcuts.unmask", cMod("shift+m", macos), ["modify-layers"]),
    "create-component-variant": def(
      "shortcuts.create-component-variant",
      cMod("k", macos),
      ["modify-layers"],
    ),
    "detach-component": def(
      "shortcuts.detach-component",
      cMod("shift+k", macos),
      ["modify-layers"],
    ),
    "flip-vertical": def("shortcuts.flip-vertical", "shift+v", ["modify-layers"]),
    "flip-horizontal": def("shortcuts.flip-horizontal", "shift+h", ["modify-layers"]),
    "bring-forward": def("shortcuts.bring-forward", cMod("up", macos), ["modify-layers"]),
    "bring-backward": def("shortcuts.bring-backward", cMod("down", macos), ["modify-layers"]),
    "bring-front": def("shortcuts.bring-front", cMod("shift+up", macos), ["modify-layers"]),
    "bring-back": def("shortcuts.bring-back", cMod("shift+down", macos), ["modify-layers"]),
    "move-fast-up": def("shortcuts.move-fast-up", ["shift+up", "shift+alt+up"], ["modify-layers"]),
    "move-fast-down": def(
      "shortcuts.move-fast-down",
      ["shift+down", "shift+alt+down"],
      ["modify-layers"],
    ),
    "move-fast-right": def(
      "shortcuts.move-fast-right",
      ["shift+right", "shift+alt+right"],
      ["modify-layers"],
    ),
    "move-fast-left": def(
      "shortcuts.move-fast-left",
      ["shift+left", "shift+alt+left"],
      ["modify-layers"],
    ),
    "move-unit-up": def("shortcuts.move-unit-up", ["up", "alt+up"], ["modify-layers"]),
    "move-unit-down": def("shortcuts.move-unit-down", ["down", "alt+down"], ["modify-layers"]),
    "move-unit-left": def("shortcuts.move-unit-left", ["right", "alt+right"], ["modify-layers"]),
    "move-unit-right": def("shortcuts.move-unit-right", ["left", "alt+left"], ["modify-layers"]),
    "artboard-selection": def(
      "shortcuts.artboard-selection",
      cMod("alt+g", macos),
      ["modify-layers"],
    ),
    "toggle-layout-flex": def("shortcuts.toggle-layout-flex", "shift+a", ["modify-layers"]),
    "toggle-layout-grid": def(
      "shortcuts.toggle-layout-grid",
      cMod("shift+a", macos),
      ["modify-layers"],
    ),
    "draw-frame": def("shortcuts.draw-frame", ["b", "a"], ["tools"]),
    "move": def("shortcuts.move", "v", ["tools"]),
    "draw-rect": def("shortcuts.draw-rect", "r", ["tools"]),
    "draw-ellipse": def("shortcuts.draw-ellipse", "e", ["tools"]),
    "draw-text": def("shortcuts.draw-text", "t", ["tools"]),
    "draw-path": def("shortcuts.draw-path", "p", ["tools"]),
    "draw-line": def("shortcuts.draw-line", "l", ["tools"]),
    "draw-arrow": def("shortcuts.draw-arrow", "shift+l", ["tools"]),
    "draw-curve": def("shortcuts.draw-curve", "shift+c", ["tools"]),
    "add-comment": def("shortcuts.add-comment", "c", ["tools"]),
    "toggle-comments-visibility": def(
      "shortcuts.toggle-comments-visibility",
      cMod("shift+c", macos),
      ["main-menu"],
    ),
    "insert-image": def("shortcuts.insert-image", "shift+k", ["tools"]),
    "toggle-visibility": def("shortcuts.toggle-visibility", cMod("shift+h", macos), ["tools"]),
    "toggle-lock": def("shortcuts.toggle-lock", cMod("shift+l", macos), ["tools"]),
    "toggle-lock-size": def("shortcuts.toggle-lock-size", "shift+l", ["tools"]),
    "scale": def("shortcuts.scale", "k", ["tools"]),
    "open-color-picker": def("shortcuts.open-color-picker", "i", ["tools"]),
    "toggle-focus-mode": def("shortcuts.toggle-focus-mode", "f", ["tools"]),
    "align-left": def("shortcuts.align-left", "alt+a", ["alignment"]),
    "align-right": def("shortcuts.align-right", "alt+d", ["alignment"]),
    "align-top": def("shortcuts.align-top", "alt+w", ["alignment"]),
    "align-hcenter": def("shortcuts.align-hcenter", "alt+h", ["alignment"]),
    "align-vcenter": def("shortcuts.align-vcenter", "alt+v", ["alignment"]),
    "align-bottom": def("shortcuts.align-bottom", "alt+s", ["alignment"]),
    "h-distribute": def("shortcuts.h-distribute", cMod("shift+alt+h", macos), ["alignment"]),
    "v-distribute": def("shortcuts.v-distribute", cMod("shift+alt+v", macos), ["alignment"]),
    "toggle-rulers": def("shortcuts.toggle-rulers", cMod("shift+r", macos), ["main-menu"]),
    "select-all": def("shortcuts.select-all", cMod("a", macos), ["main-menu"]),
    "toggle-guides": def(
      "shortcuts.toggle-guides",
      [cMod("'", macos), cMod("219", macos)],
      ["main-menu"],
    ),
    "toggle-alignment": def("shortcuts.toggle-alignment", cMod("\\", macos), ["main-menu"]),
    "thumbnail-set": def("shortcuts.thumbnail-set", "shift+t", ["main-menu"]),
    "show-pixel-grid": def("shortcuts.show-pixel-grid", "shift+,", ["main-menu"]),
    "snap-pixel-grid": def("shortcuts.snap-pixel-grid", ",", ["main-menu"]),
    "export-shapes": def("shortcuts.export-shapes", cMod("shift+e", macos), ["main-menu"]),
    "toggle-snap-ruler-guide": def(
      "shortcuts.toggle-snap-ruler-guide",
      cMod("shift+g", macos),
      ["main-menu"],
    ),
    "toggle-snap-guides": def(
      "shortcuts.toggle-snap-guides",
      [cMod("shift+'", macos), cMod("shift+219", macos)],
      ["main-menu"],
    ),
    "show-shortcuts": def("shortcuts.show-shortcuts", "?", ["main-menu"]),
    "toggle-layers": def("shortcuts.toggle-layers", aMod("l"), ["panels"]),
    "toggle-assets": def("shortcuts.toggle-assets", aMod("i"), ["panels"]),
    "toggle-history": def("shortcuts.toggle-history", cMod(aMod("h"), macos), ["panels"]),
    "toggle-colorpalette": def("shortcuts.toggle-colorpalette", aMod("p"), ["panels"]),
    "toggle-textpalette": def("shortcuts.toggle-textpalette", aMod("t"), ["panels"]),
    "hide-ui": def("shortcuts.hide-ui", "\\", ["panels"]),
    "increase-zoom": def("shortcuts.increase-zoom", ["+", "="], ["zoom-workspace"]),
    "decrease-zoom": def("shortcuts.decrease-zoom", ["-", "_"], ["zoom-workspace"]),
    "reset-zoom": def("shortcuts.reset-zoom", ["shift+0", "shift+num0"], ["zoom-workspace"]),
    "fit-all": def("shortcuts.fit-all", ["shift+1", "shift+num1"], ["zoom-workspace"]),
    "zoom-selected": def(
      "shortcuts.zoom-selected",
      ["shift+2", "shift+num2", "@", "\""],
      ["zoom-workspace"],
    ),
    "zoom-lense-increase": def("shortcuts.zoom-lense-increase", "z", ["zoom-workspace"]),
    "zoom-lense-decrease": def("shortcuts.zoom-lense-decrease", "alt+z", ["zoom-workspace"]),
    "open-viewer": def("shortcuts.open-viewer", "g v", ["navigation-workspace"]),
    "open-inspect": def("shortcuts.open-inspect", "g i", ["navigation-workspace"]),
    "open-comments": def("shortcuts.open-comments", "g c", ["navigation-workspace"]),
    "open-dashboard": def("shortcuts.open-dashboard", "g d", ["navigation-workspace"]),
    "select-prev": def("shortcuts.select-prev", "shift+tab", ["navigation-workspace"]),
    "select-next": def("shortcuts.select-next", "tab", ["navigation-workspace"]),
    "select-parent-layer": def(
      "shortcuts.select-parent-layer",
      "shift+enter",
      ["navigation-workspace"],
    ),
    "bool-union": def("shortcuts.bool-union", cMod("alt+u", macos), ["shape"]),
    "bool-difference": def("shortcuts.bool-difference", cMod("alt+d", macos), ["shape"]),
    "bool-intersection": def("shortcuts.bool-intersection", cMod("alt+i", macos), ["shape"]),
    "bool-exclude": def("shortcuts.bool-exclude", cMod("alt+e", macos), ["shape"]),
    "toggle-theme": def("shortcuts.toggle-theme", aMod("m"), ["generic"]),
    "plugins": def("shortcuts.plugins", cMod("alt+p", macos), ["generic"]),

    // --- opacity-shortcuts -----------------------------------------
    "opacity-0": def("shortcuts.opacity-0", ["0", "num0"], ["modify-layers"]),
    "opacity-1": def("shortcuts.opacity-1", ["1", "num1"], ["modify-layers"]),
    "opacity-2": def("shortcuts.opacity-2", ["2", "num2"], ["modify-layers"]),
    "opacity-3": def("shortcuts.opacity-3", ["3", "num3"], ["modify-layers"]),
    "opacity-4": def("shortcuts.opacity-4", ["4", "num4"], ["modify-layers"]),
    "opacity-5": def("shortcuts.opacity-5", ["5", "num5"], ["modify-layers"]),
    "opacity-6": def("shortcuts.opacity-6", ["6", "num6"], ["modify-layers"]),
    "opacity-7": def("shortcuts.opacity-7", ["7", "num7"], ["modify-layers"]),
    "opacity-8": def("shortcuts.opacity-8", ["8", "num8"], ["modify-layers"]),
    "opacity-9": def("shortcuts.opacity-9", ["9", "num9"], ["modify-layers"]),

    // --- text.shortcuts --------------------------------------------
    "underline": def("shortcuts.underline", cMod("u", macos), ["text-editor"]),
    "line-through": def("shortcuts.line-through", "alt+shift+5", ["text-editor"]),
    "font-size-inc": def("shortcuts.font-size-inc", cMod("shift+.", macos), ["text-editor"]),
    "font-size-dec": def("shortcuts.font-size-dec", cMod("shift+,", macos), ["text-editor"]),
    "bold": def("shortcuts.bold", cMod("b", macos), ["text-editor"]),
    "italic": def("shortcuts.italic", cMod("i", macos), ["text-editor"]),
  };
}

// workspace/path/shortcuts.cljs, the rows the page merges into the same
// section under :path-editor. The entries without :subsections in the
// original only rebind keys while path edit mode is on, so they stay out.
export function pathShortcuts(macos: boolean): WorkspaceShortcuts {
  return {
    "move-nodes": def("shortcuts.move-nodes", "m", ["path-editor"]),
    "draw-nodes": def("shortcuts.draw-nodes", "p", ["path-editor"]),
    "add-node": def("shortcuts.add-node", "shift++", ["path-editor"]),
    "delete-node": def("shortcuts.delete-node", ["del", "backspace"], ["path-editor"]),
    "delete-node-and-segments": def(
      "shortcuts.delete-node-and-segments",
      ["shift+del", "shift+backspace"],
      ["path-editor"],
    ),
    "merge-nodes": def("shortcuts.merge-nodes", cMod("j", macos), ["path-editor"]),
    "join-nodes": def("shortcuts.join-nodes", "j", ["path-editor"]),
    "separate-nodes": def("shortcuts.separate-nodes", "k", ["path-editor"]),
    "make-corner": def("shortcuts.make-corner", "x", ["path-editor"]),
    "make-curve": def("shortcuts.make-curve", "c", ["path-editor"]),
    "snap-nodes": def(
      "shortcuts.snap-nodes",
      [cMod("'", macos), cMod("219", macos)],
      ["path-editor"],
    ),
    "copy": def("shortcuts.copy", cMod("c", macos), ["path-editor"]),
    "cut": def("shortcuts.cut", cMod("x", macos), ["path-editor"]),
    "paste": def("shortcuts.paste", cMod("v", macos), ["path-editor"]),
    "duplicate": def("shortcuts.duplicate", cMod("d", macos), ["path-editor"]),
    "select-all": def("shortcuts.select-all", cMod("a", macos), ["path-editor"]),
    "deselect-all": def("shortcuts.deselect-all", cMod("shift+a", macos), ["path-editor"]),
    "flip-horizontal": def("shortcuts.flip-horizontal", "shift+h", ["path-editor"]),
    "flip-vertical": def("shortcuts.flip-vertical", "shift+v", ["path-editor"]),
  };
}

// known-shortcut-keys reads the workspace and path registries; the
// non-customizable entries (base paste) are excluded, like the CLJS page.
export const knownWorkspaceShortcutKeys: readonly string[] = [
  "undo",
  "redo",
  "clear-undo",
  "copy",
  "copy-link",
  "cut",
  "paste-replace",
  "copy-props",
  "paste-props",
  "delete",
  "duplicate",
  "start-editing",
  "show-measure",
  "escape",
  "find",
  "find-and-replace",
  "rename",
  "group",
  "ungroup",
  "mask",
  "unmask",
  "create-component-variant",
  "detach-component",
  "flip-vertical",
  "flip-horizontal",
  "bring-forward",
  "bring-backward",
  "bring-front",
  "bring-back",
  "move-fast-up",
  "move-fast-down",
  "move-fast-right",
  "move-fast-left",
  "move-unit-up",
  "move-unit-down",
  "move-unit-left",
  "move-unit-right",
  "artboard-selection",
  "toggle-layout-flex",
  "toggle-layout-grid",
  "draw-frame",
  "move",
  "draw-rect",
  "draw-ellipse",
  "draw-text",
  "draw-path",
  "draw-line",
  "draw-arrow",
  "draw-curve",
  "add-comment",
  "toggle-comments-visibility",
  "insert-image",
  "toggle-visibility",
  "toggle-lock",
  "toggle-lock-size",
  "scale",
  "open-color-picker",
  "toggle-focus-mode",
  "align-left",
  "align-right",
  "align-top",
  "align-hcenter",
  "align-vcenter",
  "align-bottom",
  "h-distribute",
  "v-distribute",
  "toggle-rulers",
  "select-all",
  "toggle-guides",
  "toggle-alignment",
  "thumbnail-set",
  "show-pixel-grid",
  "snap-pixel-grid",
  "export-shapes",
  "toggle-snap-ruler-guide",
  "toggle-snap-guides",
  "show-shortcuts",
  "toggle-layers",
  "toggle-assets",
  "toggle-history",
  "toggle-colorpalette",
  "toggle-textpalette",
  "hide-ui",
  "increase-zoom",
  "decrease-zoom",
  "reset-zoom",
  "fit-all",
  "zoom-selected",
  "zoom-lense-increase",
  "zoom-lense-decrease",
  "open-viewer",
  "open-inspect",
  "open-comments",
  "open-dashboard",
  "select-prev",
  "select-next",
  "select-parent-layer",
  "bool-union",
  "bool-difference",
  "bool-intersection",
  "bool-exclude",
  "toggle-theme",
  "plugins",
  "opacity-0",
  "opacity-1",
  "opacity-2",
  "opacity-3",
  "opacity-4",
  "opacity-5",
  "opacity-6",
  "opacity-7",
  "opacity-8",
  "opacity-9",
  "underline",
  "line-through",
  "font-size-inc",
  "font-size-dec",
  "bold",
  "italic",
  "move-nodes",
  "draw-nodes",
  "add-node",
  "delete-node",
  "delete-node-and-segments",
  "merge-nodes",
  "join-nodes",
  "separate-nodes",
  "make-corner",
  "make-curve",
  "snap-nodes",
  "paste",
  "deselect-all",
];
