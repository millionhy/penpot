import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeTransit, encodeTransit } from "@/lib/transit";
import {
  aMod,
  altLabel,
  applyCustomOverrides,
  buildCommandIndex,
  cMod,
  canonicalCommands,
  commandToTooltip,
  createShortcutMatcher,
  customShortcutsFromProfile,
  customShortcutsWire,
  eventToDisplayParts,
  eventToModifierParts,
  eventToMousetrapCommand,
  findConflict,
  isMacos,
  metaLabel,
  normalizeKey,
  resetCustomShortcut,
  setCustomShortcut,
  shortcutCommandString,
  shouldStopShortcut,
  splitSc,
  type CustomShortcuts,
  type ShortcutKeyEvent,
} from "@/lib/shortcuts";

// A keyboard event as the recording views see it: the glyph (key), the
// physical position (code) and the modifiers.
function keyEvent(overrides: ShortcutKeyEvent): ShortcutKeyEvent {
  return { key: "a", code: "KeyA", ...overrides };
}

describe("display helpers", () => {
  it("adds the control/command modifier per platform", () => {
    expect(cMod("f", true)).toBe("command+f");
    expect(cMod("f", false)).toBe("ctrl+f");
  });

  it("adds alt on every platform", () => {
    expect(aMod("m")).toBe("alt+m");
  });

  it("renders the meta label with the + quoting of the CLJS meta helper", () => {
    expect(metaLabel("F", true)).toBe("\u2318F");
    expect(metaLabel("F", false)).toBe("Ctrl+F");
    expect(metaLabel("+", false)).toBe('Ctrl+"+"');
    expect(metaLabel("+", true)).toBe("\u2318+");
  });

  it("renders the alt label", () => {
    expect(altLabel("M", true)).toBe("\u2325M");
    expect(altLabel("M", false)).toBe("Alt+M");
  });

  it("detects macos from the user agent", () => {
    expect(isMacos()).toBe(false); // node has no navigator
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
    });
    expect(isMacos()).toBe(true);
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    expect(isMacos()).toBe(false);
  });
});

describe("splitSc", () => {
  it("splits display strings on + or space", () => {
    expect(splitSc("ctrl+shift+z")).toEqual(["ctrl", "shift", "z"]);
    expect(splitSc("g d")).toEqual(["g", "d"]);
  });

  it("keeps single characters whole", () => {
    expect(splitSc("+")).toEqual(["+"]);
    expect(splitSc("a")).toEqual(["a"]);
  });

  it("spells the ++ escape out as +plus", () => {
    expect(splitSc("++")).toEqual(["", "plus"]);
  });
});

describe("commandToTooltip", () => {
  it("returns null for empty or missing commands", () => {
    expect(commandToTooltip(null, false)).toBeNull();
    expect(commandToTooltip(undefined, true)).toBeNull();
    expect(commandToTooltip("", false)).toBeNull();
  });

  it("renders modifier combinations per platform", () => {
    expect(commandToTooltip("command+shift+z", true)).toBe("\u2318\u21E7Z");
    expect(commandToTooltip("ctrl+shift+z", false)).toBe("Ctrl+Shift+Z");
    expect(commandToTooltip("alt+m", true)).toBe("\u2325M");
    expect(commandToTooltip("alt+m", false)).toBe("Alt+M");
  });

  it("renders named keys", () => {
    expect(commandToTooltip("up", false)).toBe("\u2191");
    expect(commandToTooltip("del", false)).toBe("Del");
    expect(commandToTooltip("del", true)).toBe("\u232B");
    expect(commandToTooltip("backspace", false)).toBe("Backspace");
    expect(commandToTooltip("escape", true)).toBe("\u238B");
    expect(commandToTooltip("enter", false)).toBe("Enter");
    expect(commandToTooltip("space", false)).toBe("Space");
    expect(commandToTooltip("tab", false)).toBe("tab");
  });

  it("uppercases other parts", () => {
    expect(commandToTooltip("g d", false)).toBe("G D");
    expect(commandToTooltip("f", false)).toBe("F");
  });
});

describe("normalizeKey", () => {
  it("maps key names", () => {
    expect(normalizeKey(keyEvent({ key: "ArrowUp" }))).toBe("up");
    expect(normalizeKey(keyEvent({ key: " " }))).toBe("space");
    expect(normalizeKey(keyEvent({ key: "Escape" }))).toBe("escape");
    expect(normalizeKey(keyEvent({ key: "Delete" }))).toBe("del");
  });

  it("ignores modifier-only presses", () => {
    expect(normalizeKey(keyEvent({ key: "Shift" }))).toBeNull();
    expect(normalizeKey(keyEvent({ key: "Meta" }))).toBeNull();
  });

  it("resolves punctuation through the physical code", () => {
    expect(normalizeKey(keyEvent({ key: "+", code: "Equal" }))).toBe("=");
    expect(normalizeKey(keyEvent({ key: "+", code: "NumpadAdd" }))).toBe("+");
    expect(normalizeKey(keyEvent({ key: ".", code: "Period" }))).toBe(".");
  });

  it("keeps letters and digits glyph-based", () => {
    expect(normalizeKey(keyEvent({ key: "B", code: "KeyB" }))).toBe("b");
    expect(normalizeKey(keyEvent({ key: "1", code: "Digit1" }))).toBe("1");
  });
});

describe("eventToModifierParts", () => {
  it("records ctrl only off mac", () => {
    expect(eventToModifierParts({ ctrlKey: true }, false)).toEqual(["ctrl"]);
    expect(eventToModifierParts({ ctrlKey: true }, true)).toEqual([]);
  });

  it("records meta as command only on mac", () => {
    expect(eventToModifierParts({ metaKey: true }, true)).toEqual(["command"]);
    expect(eventToModifierParts({ metaKey: true }, false)).toEqual([]);
  });

  it("records alt and shift on both platforms, in the CLJS order", () => {
    expect(eventToModifierParts({ altKey: true, shiftKey: true }, true)).toEqual([
      "alt",
      "shift",
    ]);
    expect(eventToModifierParts({ ctrlKey: true, altKey: true, shiftKey: true }, false)).toEqual([
      "ctrl",
      "alt",
      "shift",
    ]);
  });
});

describe("eventToMousetrapCommand", () => {
  it("builds the recorded combination", () => {
    expect(eventToMousetrapCommand(keyEvent({ key: "f", code: "KeyF", metaKey: true }), true)).toBe(
      "command+f",
    );
    expect(eventToMousetrapCommand(keyEvent({ key: "f", code: "KeyF", ctrlKey: true }), false)).toBe(
      "ctrl+f",
    );
  });

  it("records the US main-row plus as shift+=", () => {
    expect(
      eventToMousetrapCommand(keyEvent({ key: "+", code: "Equal", shiftKey: true }), false),
    ).toBe("shift+=");
  });

  it("returns null for modifier-only presses", () => {
    expect(eventToMousetrapCommand({ key: "Shift", shiftKey: true }, false)).toBeNull();
  });
});

describe("eventToDisplayParts", () => {
  it("stays unfinalized while only modifiers are held", () => {
    expect(eventToDisplayParts({ key: "Shift", shiftKey: true }, true)).toEqual({
      modifiers: ["shift"],
      finalized: false,
    });
  });

  it("finalizes on a regular key", () => {
    expect(eventToDisplayParts(keyEvent({ key: "m", code: "KeyM", altKey: true }), false)).toEqual({
      modifiers: ["alt"],
      finalKey: "m",
      finalized: true,
    });
  });
});

describe("canonicalCommands", () => {
  it("passes simple combinations through", () => {
    expect(canonicalCommands("alt+m")).toEqual(["alt+m"]);
    expect(canonicalCommands("ctrl+f")).toEqual(["ctrl+f"]);
    expect(canonicalCommands("command+f")).toEqual(["command+f"]);
  });

  it("keeps sequences space-separated", () => {
    expect(canonicalCommands("g d")).toEqual(["g d"]);
  });

  it("orders modifiers canonically regardless of the written order", () => {
    expect(canonicalCommands("shift+command+z")).toEqual(["command+shift+z"]);
    expect(canonicalCommands("shift+ctrl+z")).toEqual(["ctrl+shift+z"]);
  });

  it("expands + to the literal plus and the US main-row form", () => {
    expect(canonicalCommands("+")).toEqual(["+", "shift+="]);
    expect(canonicalCommands("plus")).toEqual(["+", "shift+="]);
    expect(canonicalCommands("++")).toEqual(["+", "shift+="]);
  });

  it("applies the mousetrap aliases", () => {
    expect(canonicalCommands("option+m")).toEqual(["alt+m"]);
    expect(canonicalCommands("meta+f")).toEqual(["command+f"]);
    expect(canonicalCommands("return")).toEqual(["enter"]);
    expect(canonicalCommands("escape")).toEqual(["esc"]);
  });

  it("returns nothing for empty or modifier-only commands", () => {
    expect(canonicalCommands("")).toEqual([]);
    expect(canonicalCommands(null)).toEqual([]);
    expect(canonicalCommands("shift+alt")).toEqual([]);
  });
});

describe("createShortcutMatcher", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a single combination and reports it", () => {
    const run = vi.fn();
    const matcher = createShortcutMatcher([{ command: "alt+m", run }]);
    expect(matcher.handle("alt+m")).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(matcher.handle("alt+shift+m")).toBe(false);
    matcher.dispose();
  });

  it("matches the plus binding from the numpad and Shift+=", () => {
    const run = vi.fn();
    const matcher = createShortcutMatcher([{ command: "+", run }]);
    expect(matcher.handle("+")).toBe(true);
    expect(matcher.handle("shift+=")).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    matcher.dispose();
  });

  it("skips disabled and empty bindings", () => {
    const run = vi.fn();
    const matcher = createShortcutMatcher([
      { command: "alt+m", disabled: true, run },
      { command: "", run },
    ]);
    expect(matcher.handle("alt+m")).toBe(false);
    matcher.dispose();
  });

  it("binds vector commands as alternatives", () => {
    const run = vi.fn();
    const matcher = createShortcutMatcher([{ command: ["g d", "alt+m"], run }]);
    expect(matcher.handle("alt+m")).toBe(true);
    expect(matcher.handle("g")).toBe(false);
    expect(matcher.handle("d")).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    matcher.dispose();
  });

  it("runs sequences within the second timeout", () => {
    vi.useFakeTimers();
    const drafts = vi.fn();
    const libs = vi.fn();
    const matcher = createShortcutMatcher([
      { command: "g d", run: drafts },
      { command: "g l", run: libs },
    ]);
    expect(matcher.handle("g")).toBe(false);
    expect(drafts).not.toHaveBeenCalled();
    expect(matcher.handle("d")).toBe(true);
    expect(drafts).toHaveBeenCalledTimes(1);
    expect(libs).not.toHaveBeenCalled();
    matcher.dispose();
  });

  it("resets the sequence when the next key misses", () => {
    vi.useFakeTimers();
    const drafts = vi.fn();
    const matcher = createShortcutMatcher([{ command: "g d", run: drafts }]);
    matcher.handle("g");
    matcher.handle("x");
    expect(matcher.handle("d")).toBe(false);
    expect(drafts).not.toHaveBeenCalled();
    matcher.dispose();
  });

  it("expires an unfinished sequence after one second", () => {
    vi.useFakeTimers();
    const drafts = vi.fn();
    const matcher = createShortcutMatcher([{ command: "g d", run: drafts }]);
    matcher.handle("g");
    vi.advanceTimersByTime(1001);
    expect(matcher.handle("d")).toBe(false);
    matcher.dispose();
  });

  it("only fires the longest sequence match of one event", () => {
    vi.useFakeTimers();
    const sequence = vi.fn();
    const single = vi.fn();
    const matcher = createShortcutMatcher([
      { command: "g d", run: sequence },
      { command: "d", run: single },
    ]);
    matcher.handle("g");
    expect(matcher.handle("d")).toBe(true);
    expect(sequence).toHaveBeenCalledTimes(1);
    expect(single).not.toHaveBeenCalled();
    matcher.dispose();
  });

  it("fires a plain single even while another sequence is pending", () => {
    vi.useFakeTimers();
    const drafts = vi.fn();
    const single = vi.fn();
    const matcher = createShortcutMatcher([
      { command: "g d", run: drafts },
      { command: "alt+m", run: single },
    ]);
    matcher.handle("g");
    expect(matcher.handle("alt+m")).toBe(true);
    expect(single).toHaveBeenCalledTimes(1);
    // The alt+m keydown matched no sequence, so "g d" was reset.
    expect(matcher.handle("d")).toBe(false);
    expect(drafts).not.toHaveBeenCalled();
    matcher.dispose();
  });

  it("ignores modifier-only combinations", () => {
    vi.useFakeTimers();
    const drafts = vi.fn();
    const matcher = createShortcutMatcher([{ command: "g d", run: drafts }]);
    matcher.handle("g");
    expect(matcher.handle("shift")).toBe(false);
    expect(matcher.handle("d")).toBe(true);
    expect(drafts).toHaveBeenCalledTimes(1);
    matcher.dispose();
  });

  it("does not fire inside inputs unless the target opts out", () => {
    const run = vi.fn();
    const matcher = createShortcutMatcher([{ command: "alt+m", run }]);
    expect(matcher.handle("alt+m", { tagName: "INPUT" })).toBe(false);
    expect(run).not.toHaveBeenCalled();
    expect(
      matcher.handle("alt+m", { tagName: "INPUT", dataset: { mousetrapDontStop: true } }),
    ).toBe(true);
    expect(matcher.handle("alt+m", { tagName: "DIV", className: "foo mousetrap bar" })).toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
    matcher.dispose();
  });

  it("clears its timer on dispose", () => {
    vi.useFakeTimers();
    const matcher = createShortcutMatcher([{ command: "g d", run: vi.fn() }]);
    matcher.handle("g");
    expect(vi.getTimerCount()).toBe(1);
    matcher.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("shouldStopShortcut", () => {
  it("stops form controls", () => {
    expect(shouldStopShortcut({ tagName: "INPUT" }, "a")).toBe(true);
    expect(shouldStopShortcut({ tagName: "SELECT" }, "a")).toBe(true);
    expect(shouldStopShortcut({ tagName: "TEXTAREA" }, "a")).toBe(true);
  });

  it("stops buttons only for tab combinations", () => {
    expect(shouldStopShortcut({ tagName: "BUTTON" }, "tab")).toBe(true);
    expect(shouldStopShortcut({ tagName: "BUTTON" }, "shift+tab")).toBe(true);
    expect(shouldStopShortcut({ tagName: "BUTTON" }, "a")).toBe(false);
  });

  it("stops editable regions", () => {
    expect(shouldStopShortcut({ tagName: "DIV", contentEditable: "true" }, "a")).toBe(true);
    expect(shouldStopShortcut({ tagName: "DIV", contentEditable: "plaintext-only" }, "a")).toBe(
      true,
    );
    expect(shouldStopShortcut({ tagName: "DIV", contentEditable: "false" }, "a")).toBe(false);
    expect(shouldStopShortcut({ tagName: "DIV", contentEditable: "inherit" }, "a")).toBe(false);
  });

  it("lets opted-out elements through", () => {
    expect(shouldStopShortcut({ tagName: "INPUT", dataset: { mousetrapDontStop: null } }, "a")).toBe(
      false,
    );
    expect(shouldStopShortcut({ tagName: "INPUT", className: "mousetrap" }, "a")).toBe(false);
  });
});

describe("applyCustomOverrides", () => {
  const base = {
    "toggle-theme": { command: "alt+m" },
    "go-to-drafts": { command: "g d", showCommand: "g d" },
    pasted: { command: "ctrl+v", disabled: true },
  };

  it("returns the input untouched without overrides", () => {
    expect(applyCustomOverrides(base, {}, "dashboard")).toBe(base);
    expect(applyCustomOverrides(base, null, "dashboard")).toBe(base);
  });

  it("replaces the command, keeps the original and drops show-command", () => {
    const done = applyCustomOverrides(base, { dashboard: { "go-to-drafts": "alt+d" } }, "dashboard");
    expect(done["go-to-drafts"]).toEqual({
      command: "alt+d",
      originalCommand: "g d",
    });
    expect(done["toggle-theme"]).toEqual({ command: "alt+m" });
  });

  it("can disable with an empty command", () => {
    const done = applyCustomOverrides(base, { dashboard: { "toggle-theme": "" } }, "dashboard");
    expect(done["toggle-theme"].command).toBe("");
  });

  it("leaves disabled definitions and unknown keys alone", () => {
    const done = applyCustomOverrides(
      base,
      { dashboard: { pasted: "ctrl+shift+v", missing: "x" } },
      "dashboard",
    );
    expect(done.pasted).toEqual({ command: "ctrl+v", disabled: true });
    expect("missing" in done).toBe(false);
  });

  it("keeps other groups out", () => {
    const done = applyCustomOverrides(
      base,
      { workspace: { "toggle-theme": "alt+x" } },
      "dashboard",
    );
    expect(done["toggle-theme"].command).toBe("alt+m");
  });
});

describe("buildCommandIndex / findConflict", () => {
  const all = {
    "toggle-theme": { command: "alt+m", labelKey: "shortcuts.toggle-theme" },
    "go-to-drafts": { command: "g d" },
    other: { command: ["a", "b"] },
  };

  it("indexes every command, vectors included", () => {
    expect(buildCommandIndex(all)).toEqual({
      "alt+m": "toggle-theme",
      "g d": "go-to-drafts",
      a: "other",
      b: "other",
    });
  });

  it("reports a conflict with the label key", () => {
    expect(findConflict("alt+m", all, "go-to-drafts")).toEqual({
      key: "toggle-theme",
      labelKey: "shortcuts.toggle-theme",
    });
  });

  it("falls back to the shortcuts.<key> label", () => {
    expect(findConflict("g d", all, "toggle-theme")).toEqual({
      key: "go-to-drafts",
      labelKey: "shortcuts.go-to-drafts",
    });
  });

  it("returns null for the edited key itself and for free commands", () => {
    expect(findConflict("alt+m", all, "toggle-theme")).toBeNull();
    expect(findConflict("alt+z", all, "toggle-theme")).toBeNull();
  });
});

describe("shortcutCommandString", () => {
  it("prefers show-command and lowercases", () => {
    expect(shortcutCommandString({ command: "alt+m" })).toBe("alt+m");
    expect(shortcutCommandString({ command: "alt+m", showCommand: "Alt+M" })).toBe("alt+m");
  });

  it("joins vector commands and handles unbound entries", () => {
    expect(shortcutCommandString({ command: ["g d", "Alt+D"] })).toBe("g d alt+d");
    expect(shortcutCommandString({})).toBe("");
  });
});

describe("custom shortcut transforms", () => {
  it("setCustomShortcut stores the command and clears the conflict", () => {
    const next = setCustomShortcut({}, "go-to-drafts", "alt+d", "toggle-theme", "dashboard");
    expect(next).toEqual({ dashboard: { "go-to-drafts": "alt+d", "toggle-theme": "" } });
  });

  it("setCustomShortcut keeps other groups and skips an empty conflict", () => {
    const next = setCustomShortcut(
      { workspace: { zoom: "" }, dashboard: { "toggle-theme": "alt+x" } },
      "toggle-theme",
      "alt+m",
      null,
      "dashboard",
    );
    expect(next).toEqual({
      workspace: { zoom: "" },
      dashboard: { "toggle-theme": "alt+m" },
    });
  });

  it("resetCustomShortcut drops the key and disables the default command owner", () => {
    const next = resetCustomShortcut(
      { dashboard: { "go-to-drafts": "alt+d", "toggle-theme": "g d" } },
      "go-to-drafts",
      "g d",
      "dashboard",
    );
    expect(next).toEqual({ dashboard: { "toggle-theme": "" } });
  });

  it("resetCustomShortcut matches vector default commands", () => {
    const next = resetCustomShortcut(
      { dashboard: { "go-to-drafts": "alt+b" } },
      "toggle-theme",
      ["alt+m", "alt+b"],
      "dashboard",
    );
    expect(next).toEqual({ dashboard: { "go-to-drafts": "" } });
  });

  it("resetCustomShortcut removes an emptied group", () => {
    expect(
      resetCustomShortcut({ dashboard: { "go-to-drafts": "alt+d" } }, "go-to-drafts", "g d", "dashboard"),
    ).toEqual({});
  });

  it("resetCustomShortcut does not disable the reset key itself", () => {
    const next = resetCustomShortcut(
      { dashboard: { "go-to-drafts": "g d" } },
      "go-to-drafts",
      "g d",
      "dashboard",
    );
    expect(next).toEqual({});
  });
});

describe("profile props round-trip", () => {
  const customs: CustomShortcuts = { dashboard: { "toggle-theme": "alt+x" } };

  it("reads the stored props and drops malformed entries", () => {
    expect(
      customShortcutsFromProfile({ props: { "custom-shortcuts": { dashboard: { a: "b", c: 1 } } } }),
    ).toEqual({ dashboard: { a: "b" } });
    expect(customShortcutsFromProfile(null)).toEqual({});
    expect(customShortcutsFromProfile({ props: { "custom-shortcuts": 5 } })).toEqual({});
    expect(customShortcutsFromProfile({ props: { "custom-shortcuts": ["x"] } })).toEqual({});
  });

  it("writes transit keyword keys at both levels", () => {
    const text = encodeTransit(customShortcutsWire(customs));
    expect(text).toContain('"~:dashboard"');
    expect(text).toContain('"~:toggle-theme"');
    expect(decodeTransit(text)).toEqual(customs);
  });
});
