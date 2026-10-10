import { describe, expect, it, vi } from "vitest";
import { tr } from "@/lib/i18n";
import { createShortcutMatcher, type CustomShortcuts } from "@/lib/shortcuts";
import {
  runViewerShortcut,
  unmigratedViewerShortcuts,
  viewerShortcuts,
  type ViewerShortcutActions,
  type ViewerShortcutKey,
} from "@/lib/viewer-shortcuts";
import {
  buildViewerBindings,
  dispatchViewerKeydown,
  isWheelZoomMod,
  wheelZoomDirection,
} from "@/lib/viewer-shortcuts-runtime";

const allKeys: ViewerShortcutKey[] = [
  "increase-zoom",
  "toggle-theme",
  "decrease-zoom",
  "select-all",
  "reset-zoom",
  "toggle-zoom-style",
  "toggle-fullscreen",
  "prev-frame",
  "next-frame",
  "open-inspect",
  "open-comments",
  "open-interactions",
  "open-workspace",
];

describe("viewerShortcuts", () => {
  it("keeps the CLJS map order of the 13 definitions", () => {
    expect(Object.keys(viewerShortcuts(false))).toEqual(allKeys);
  });

  it("builds the platform commands", () => {
    expect(viewerShortcuts(false)["increase-zoom"].command).toBe("+");
    expect(viewerShortcuts(false)["toggle-theme"].command).toBe("alt+m");
    expect(viewerShortcuts(true)["select-all"].command).toBe("command+a");
    expect(viewerShortcuts(false)["select-all"].command).toBe("ctrl+a");
    expect(viewerShortcuts(false)["decrease-zoom"].command).toBe("-");
    expect(viewerShortcuts(false)["reset-zoom"].command).toBe("shift+0");
    expect(viewerShortcuts(false)["toggle-zoom-style"].command).toBe("f");
    expect(viewerShortcuts(false)["toggle-fullscreen"].command).toEqual(["shift+f", "alt+enter"]);
    expect(viewerShortcuts(false)["prev-frame"].command).toEqual([
      "left",
      "up",
      "shift+enter",
      "pageup",
      "shift+space",
    ]);
    expect(viewerShortcuts(false)["next-frame"].command).toEqual([
      "right",
      "down",
      "enter",
      "pagedown",
      "space",
    ]);
    expect(viewerShortcuts(false)["open-inspect"].command).toBe("g i");
    expect(viewerShortcuts(false)["open-comments"].command).toBe("g c");
    expect(viewerShortcuts(false)["open-interactions"].command).toBe("g v");
    expect(viewerShortcuts(false)["open-workspace"].command).toBe("g w");
  });

  it("builds the platform tooltips", () => {
    expect(viewerShortcuts(true)["toggle-theme"].tooltip).toBe("\u2325M");
    expect(viewerShortcuts(false)["toggle-theme"].tooltip).toBe("Alt+M");
    expect(viewerShortcuts(true)["select-all"].tooltip).toBe("\u2318A");
    expect(viewerShortcuts(false)["select-all"].tooltip).toBe("Ctrl+A");
    expect(viewerShortcuts(true)["reset-zoom"].tooltip).toBe("\u21E70");
    expect(viewerShortcuts(false)["reset-zoom"].tooltip).toBe("Shift+0");
    expect(viewerShortcuts(true)["toggle-fullscreen"].tooltip).toBe("\u21E7F");
    expect(viewerShortcuts(false)["toggle-fullscreen"].tooltip).toBe("Shift+F");
    expect(viewerShortcuts(false)["prev-frame"].tooltip).toBe("\u2190");
    expect(viewerShortcuts(false)["next-frame"].tooltip).toBe("\u2192");
    expect(viewerShortcuts(false)["increase-zoom"].tooltip).toBe("+");
    expect(viewerShortcuts(false)["decrease-zoom"].tooltip).toBe("-");
    expect(viewerShortcuts(false)["toggle-zoom-style"].tooltip).toBe("F");
    expect(viewerShortcuts(false)["open-inspect"].tooltip).toBe("G I");
    expect(viewerShortcuts(false)["open-comments"].tooltip).toBe("G C");
    expect(viewerShortcuts(false)["open-interactions"].tooltip).toBe("G V");
    expect(viewerShortcuts(false)["open-workspace"].tooltip).toBe("G W");
  });

  it("keeps every definition in the viewer section with its subsection", () => {
    for (const key of allKeys) {
      const definition = viewerShortcuts(false)[key];
      expect(definition.section).toEqual(["viewer"]);
      expect(definition.subsections).toHaveLength(1);
    }
    const zoomKeys = [
      "increase-zoom",
      "decrease-zoom",
      "reset-zoom",
      "toggle-zoom-style",
      "toggle-fullscreen",
    ] as const;
    for (const key of zoomKeys) {
      expect(viewerShortcuts(false)[key].subsections).toEqual(["zoom-viewer"]);
    }
    const genericKeys = ["toggle-theme", "select-all", "prev-frame", "next-frame"] as const;
    for (const key of genericKeys) {
      expect(viewerShortcuts(false)[key].subsections).toEqual(["generic"]);
    }
    const navigationKeys = [
      "open-inspect",
      "open-comments",
      "open-interactions",
      "open-workspace",
    ] as const;
    for (const key of navigationKeys) {
      expect(viewerShortcuts(false)[key].subsections).toEqual(["navigation-viewer"]);
    }
  });
});

describe("unmigratedViewerShortcuts", () => {
  it("lists the three shortcuts without a shell consumer", () => {
    expect(unmigratedViewerShortcuts).toEqual(["select-all", "open-inspect", "open-comments"]);
  });
});

function fakeActions() {
  return {
    increaseZoom: vi.fn(),
    decreaseZoom: vi.fn(),
    resetZoom: vi.fn(),
    toggleZoomStyle: vi.fn(),
    toggleFullscreen: vi.fn(),
    prevFrame: vi.fn(),
    nextFrame: vi.fn(),
    toggleTheme: vi.fn(),
    goToInteractions: vi.fn(),
    goToWorkspace: vi.fn(),
  } satisfies ViewerShortcutActions;
}

describe("runViewerShortcut", () => {
  it("dispatches every migrated key to its action", () => {
    const actions = fakeActions();
    runViewerShortcut("increase-zoom", actions);
    runViewerShortcut("decrease-zoom", actions);
    runViewerShortcut("reset-zoom", actions);
    runViewerShortcut("toggle-zoom-style", actions);
    runViewerShortcut("toggle-fullscreen", actions);
    runViewerShortcut("prev-frame", actions);
    runViewerShortcut("next-frame", actions);
    runViewerShortcut("toggle-theme", actions);
    runViewerShortcut("open-interactions", actions);
    runViewerShortcut("open-workspace", actions);
    expect(actions.increaseZoom).toHaveBeenCalledTimes(1);
    expect(actions.decreaseZoom).toHaveBeenCalledTimes(1);
    expect(actions.resetZoom).toHaveBeenCalledTimes(1);
    expect(actions.toggleZoomStyle).toHaveBeenCalledTimes(1);
    expect(actions.toggleFullscreen).toHaveBeenCalledTimes(1);
    expect(actions.prevFrame).toHaveBeenCalledTimes(1);
    expect(actions.nextFrame).toHaveBeenCalledTimes(1);
    expect(actions.toggleTheme).toHaveBeenCalledTimes(1);
    expect(actions.goToInteractions).toHaveBeenCalledTimes(1);
    expect(actions.goToWorkspace).toHaveBeenCalledTimes(1);
  });

  it("runs the unmigrated keys as no-ops", () => {
    const actions = fakeActions();
    runViewerShortcut("select-all", actions);
    runViewerShortcut("open-inspect", actions);
    runViewerShortcut("open-comments", actions);
    for (const action of Object.values(actions)) {
      expect(action).not.toHaveBeenCalled();
    }
  });
});

describe("buildViewerBindings", () => {
  it("binds the ten migrated shortcuts in map order", () => {
    const bindings = buildViewerBindings(false, null, fakeActions());
    expect(bindings.map((binding) => binding.command)).toEqual([
      "+",
      "alt+m",
      "-",
      "shift+0",
      "f",
      ["shift+f", "alt+enter"],
      ["left", "up", "shift+enter", "pageup", "shift+space"],
      ["right", "down", "enter", "pagedown", "space"],
      "g v",
      "g w",
    ]);
  });

  it("dispatches every binding to its action", () => {
    const actions = fakeActions();
    const bindings = buildViewerBindings(false, null, actions);
    const run = (command: string) => bindings.find((binding) => binding.command === command)!.run();
    run("+");
    expect(actions.increaseZoom).toHaveBeenCalledTimes(1);
    run("alt+m");
    expect(actions.toggleTheme).toHaveBeenCalledTimes(1);
    run("-");
    expect(actions.decreaseZoom).toHaveBeenCalledTimes(1);
    run("shift+0");
    expect(actions.resetZoom).toHaveBeenCalledTimes(1);
    run("f");
    expect(actions.toggleZoomStyle).toHaveBeenCalledTimes(1);
    run("g v");
    expect(actions.goToInteractions).toHaveBeenCalledTimes(1);
    run("g w");
    expect(actions.goToWorkspace).toHaveBeenCalledTimes(1);
    bindings.find((b) => Array.isArray(b.command) && b.command.includes("alt+enter"))!.run();
    expect(actions.toggleFullscreen).toHaveBeenCalledTimes(1);
    bindings.find((b) => Array.isArray(b.command) && b.command.includes("left"))!.run();
    expect(actions.prevFrame).toHaveBeenCalledTimes(1);
    bindings.find((b) => Array.isArray(b.command) && b.command.includes("space"))!.run();
    expect(actions.nextFrame).toHaveBeenCalledTimes(1);
  });

  it("applies the viewer group overrides", () => {
    const customs: CustomShortcuts = { viewer: { "increase-zoom": "z" } };
    const bindings = buildViewerBindings(false, customs, fakeActions());
    expect(bindings[0].command).toBe("z");
  });

  it("ignores overrides of other groups", () => {
    const customs: CustomShortcuts = { dashboard: { "increase-zoom": "z" } };
    const bindings = buildViewerBindings(false, customs, fakeActions());
    expect(bindings[0].command).toBe("+");
  });

  it("keeps a cleared override as a binding the matcher never fires", () => {
    const customs: CustomShortcuts = { viewer: { "increase-zoom": "" } };
    const actions = fakeActions();
    const bindings = buildViewerBindings(false, customs, actions);
    expect(bindings[0].command).toBe("");
    const matcher = createShortcutMatcher(bindings);
    expect(matcher.handle("+")).toBe(false);
    expect(actions.increaseZoom).not.toHaveBeenCalled();
    matcher.dispose();
  });
});

describe("dispatchViewerKeydown", () => {
  it("fires a single-key binding from its keydown event", () => {
    const actions = fakeActions();
    const matcher = createShortcutMatcher(buildViewerBindings(false, null, actions));
    const fired = dispatchViewerKeydown(matcher, { key: "f", code: "KeyF" }, false);
    expect(fired).toBe(true);
    expect(actions.toggleZoomStyle).toHaveBeenCalledTimes(1);
    matcher.dispose();
  });

  it("fires the frame navigation from the arrow keys", () => {
    const actions = fakeActions();
    const matcher = createShortcutMatcher(buildViewerBindings(false, null, actions));
    expect(dispatchViewerKeydown(matcher, { key: "ArrowLeft", code: "ArrowLeft" }, false)).toBe(true);
    expect(dispatchViewerKeydown(matcher, { key: "ArrowRight", code: "ArrowRight" }, false)).toBe(
      true,
    );
    expect(actions.prevFrame).toHaveBeenCalledTimes(1);
    expect(actions.nextFrame).toHaveBeenCalledTimes(1);
    matcher.dispose();
  });

  it("matches Shift+= as the + binding (US main row)", () => {
    const actions = fakeActions();
    const matcher = createShortcutMatcher(buildViewerBindings(false, null, actions));
    const fired = dispatchViewerKeydown(matcher, { key: "+", code: "Equal", shiftKey: true }, false);
    expect(fired).toBe(true);
    expect(actions.increaseZoom).toHaveBeenCalledTimes(1);
    matcher.dispose();
  });

  it("advances the two-step sequences across keydowns", () => {
    const actions = fakeActions();
    const matcher = createShortcutMatcher(buildViewerBindings(false, null, actions));
    dispatchViewerKeydown(matcher, { key: "g", code: "KeyG" }, false);
    dispatchViewerKeydown(matcher, { key: "v", code: "KeyV" }, false);
    expect(actions.goToInteractions).toHaveBeenCalledTimes(1);
    matcher.dispose();
  });

  it("ignores standalone modifier presses", () => {
    const actions = fakeActions();
    const matcher = createShortcutMatcher(buildViewerBindings(false, null, actions));
    expect(dispatchViewerKeydown(matcher, { key: "Shift", shiftKey: true }, false)).toBe(false);
    for (const action of Object.values(actions)) {
      expect(action).not.toHaveBeenCalled();
    }
    matcher.dispose();
  });

  it("does not fire inside text inputs", () => {
    const actions = fakeActions();
    const matcher = createShortcutMatcher(buildViewerBindings(false, null, actions));
    const fired = dispatchViewerKeydown(
      matcher,
      { key: "f", code: "KeyF" },
      false,
      { tagName: "INPUT" },
    );
    expect(fired).toBe(false);
    expect(actions.toggleZoomStyle).not.toHaveBeenCalled();
    matcher.dispose();
  });
});

describe("isWheelZoomMod", () => {
  it("reads meta on mac and ctrl elsewhere", () => {
    expect(isWheelZoomMod(true, { metaKey: true })).toBe(true);
    expect(isWheelZoomMod(true, { ctrlKey: true })).toBe(false);
    expect(isWheelZoomMod(false, { ctrlKey: true })).toBe(true);
    expect(isWheelZoomMod(false, { metaKey: true })).toBe(false);
    expect(isWheelZoomMod(false, {})).toBe(false);
  });
});

describe("wheelZoomDirection", () => {
  it("zooms out on a positive total delta", () => {
    expect(wheelZoomDirection(1, 0)).toBe("decrease");
    expect(wheelZoomDirection(0, 5)).toBe("decrease");
  });

  it("zooms in on zero or negative deltas", () => {
    expect(wheelZoomDirection(-1, 0)).toBe("increase");
    expect(wheelZoomDirection(0, -5)).toBe("increase");
    expect(wheelZoomDirection(0, 0)).toBe("increase");
    expect(wheelZoomDirection(5, -5)).toBe("increase");
  });
});

describe("label keys", () => {
  it("resolve through the generated catalog", () => {
    // tr() falls back to the key itself, so a label the extractor missed would
    // render as its own name. The definitions keep their keys in the labelKey
    // data field, which scripts/extract-translations.mjs scans via trFieldRe.
    for (const key of allKeys) {
      const definition = viewerShortcuts(false)[key];
      expect(tr(definition.labelKey)).not.toBe(definition.labelKey);
    }
  });
});
