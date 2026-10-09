// Shortcut mechanics (F5.6). Headless port of three CLJS namespaces:
// - app.main.ui.shortcuts: normalize-key, event->modifier-parts,
//   keyboard-event->mousetrap, keyboard-event->display-parts, split-sc,
//   command->tooltip, find-conflict and shortcut->command-string.
// - app.main.data.shortcuts: the c-mod/a-mod/meta/alt display helpers,
//   apply-custom-overrides and build-command-index.
// - app.main.data.dashboard.shortcuts.customize: the custom-shortcut map
//   transforms.
//
// The dashboard registry itself (definitions, sets, action dispatch) lives in
// lib/dashboard-shortcuts.ts; the keydown listener and the views land with the
// settings/shortcuts page.
//
// Kept free of JSX so it runs in vitest's node environment, like lib/forms.ts.
// The keyboard event type is a structural subset of KeyboardEvent so tests do
// not need jsdom.
//
// Deviations from the CLJS original, documented:
// - Matching is keydown-only. The CLJS app hands canonical combinations to the
//   bundled Mousetrap, which listens for keydown, keypress and keyup; the
//   shell listens for keydown only. Mousetrap's extra paths exist for
//   printable-character bindings, which no dashboard shortcut has (see also
//   the "+" note below). Modifier-only presses are ignored, mirroring
//   Mousetrap (they neither fire nor reset sequences).
// - The "+" binding also matches Shift+=. In the CLJS app the mousetrap
//   _SHIFT_MAP expansion of "+" only applies when bind() receives an explicit
//   action, and bind! passes none, so "+" fires on the numpad plus glyph
//   alone. Matching Shift+= ("+" on the US main row) as the same binding is a
//   deliberate fix, visible in the shortcut tooltip "+".
// - Punctuation is canonicalized from event.code through the same table as
//   the recording half (code-name-map), so a binding and its recording always
//   agree regardless of layout; see the table comment below.
// - The guard is Mousetrap's stopCallback without the keyup and shadow-DOM
//   branches: the shell has one keydown listener on the document and no open
//   shadow trees.

import { keywordMap } from "@/lib/transit";

// --- Display helpers (data/shortcuts.cljs) ---------------------------------

export const macCommand = "\u2318";
export const macOption = "\u2325";
export const macDelete = "\u232B";
export const macShift = "\u21E7";
export const macControl = "\u2303";
export const macEsc = "\u238B";
export const macEnter = "\u23CE";

export const leftArrow = "\u2190";
export const upArrow = "\u2191";
export const rightArrow = "\u2192";
export const downArrow = "\u2193";

// Check-platform? :macos reads the user agent (config.cljs). Client-only in
// practice; the guard keeps module evaluation SSR-safe.
export function isMacos(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.userAgent !== "string") return false;
  return navigator.userAgent.toLowerCase().includes("mac os");
}

// The control/command modifier depending on the platform.
export function cMod(key: string, macos: boolean): string {
  return macos ? "command+" + key : "ctrl+" + key;
}

// The alt/option modifier; the command string is "alt+" on every platform.
export function aMod(key: string): string {
  return "alt+" + key;
}

// The meta/ctrl display form ("⌘F" on mac, "Ctrl+F" elsewhere). "+" keeps its
// quotes off mac where a bare + would read as a separator.
export function metaLabel(key: string, macos: boolean): string {
  const display = !macos && key === "+" ? '"+"' : key;
  return (macos ? macCommand : "Ctrl+") + display;
}

export function altLabel(key: string, macos: boolean): string {
  return (macos ? macOption : "Alt+") + key;
}

// split-sc: display-string -> key tokens, with the mousetrap "++" escape
// ("++" binds the literal plus) spelled out as "+plus".
export function splitSc(sc: string): string[] {
  const normalized = sc.replace(/\+\+/g, "+plus");
  if (normalized.length === 1) return [normalized];
  return normalized.split(/\+| /);
}

// command->tooltip: mousetrap command -> human display ("command+shift+z"
// -> "⌘⇧Z" / "Ctrl+Shift+Z"). Returns null for empty or unbound commands.
export function commandToTooltip(command: string | null | undefined, macos: boolean): string | null {
  if (command === null || command === undefined || command === "") return null;
  const displayPart = (part: string): string => {
    switch (part) {
      case "ctrl":
        return macos ? macControl : "Ctrl+";
      case "command":
        return macos ? macCommand : "Ctrl+";
      case "alt":
        return macos ? macOption : "Alt+";
      case "shift":
        return macos ? macShift : "Shift+";
      case "up":
        return upArrow;
      case "down":
        return downArrow;
      case "left":
        return leftArrow;
      case "right":
        return rightArrow;
      case "del":
        return macos ? macDelete : "Del";
      case "backspace":
        return macos ? macDelete : "Backspace";
      case "escape":
        return macos ? macEsc : "Escape";
      case "enter":
        return macos ? macEnter : "Enter";
      case "space":
        return "Space";
      case "tab":
        return "tab";
      default:
        return part.toUpperCase();
    }
  };
  return command.split("+").map(displayPart).join("");
}

// --- Event normalization (ui/shortcuts.cljs) -------------------------------

export interface ShortcutKeyEvent {
  key?: string;
  code?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

const modifierEventKeys = new Set(["Control", "Shift", "Alt", "Meta"]);

const keyNameMap: Record<string, string> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Escape: "escape",
  Enter: "enter",
  Backspace: "backspace",
  Delete: "del",
  Tab: "tab",
  " ": "space",
};

// Mousetrap (the CLJS runtime matcher) resolves a keydown positionally - via
// keyCode - ONLY for this punctuation set (its _KEYCODE_MAP); it falls back to
// event.key.toLowerCase() (glyph-based) for letters and digits, which are not
// in that map. Recording punctuation from `code` therefore matches what the
// matcher triggers regardless of layout (e.g. the key next to Right Shift on
// a US layout is always "Period", whatever glyph it types on an ISO layout).
// Letters/digits stay glyph-based to match Mousetrap's own resolution for
// them; canonicalCommands() below applies the same table to binding strings.
const codeNameMap: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

// normalize-key: the canonical, mousetrap-compatible name of the pressed key,
// or null for modifier-only presses.
export function normalizeKey(event: ShortcutKeyEvent): string | null {
  const key = event.key;
  if (key === undefined || key === null || modifierEventKeys.has(key)) return null;
  const fromCode = event.code !== undefined ? codeNameMap[event.code] : undefined;
  return keyNameMap[key] ?? fromCode ?? key.toLowerCase();
}

// event->modifier-parts: ctrl is only recorded off mac, meta only on mac; a
// recording made on one platform does not fire on the other, like the CLJS
// matcher.
export function eventToModifierParts(event: ShortcutKeyEvent, macos: boolean): string[] {
  const parts: string[] = [];
  if (event.ctrlKey === true && !macos) parts.push("ctrl");
  if (event.metaKey === true && macos) parts.push("command");
  if (event.altKey === true) parts.push("alt");
  if (event.shiftKey === true) parts.push("shift");
  return parts;
}

// keyboard-event->mousetrap: the combination string stored as a custom
// shortcut ("command+shift+z", "shift+=", "+").
export function eventToMousetrapCommand(event: ShortcutKeyEvent, macos: boolean): string | null {
  const key = normalizeKey(event);
  if (key === null) return null;
  return [...eventToModifierParts(event, macos), key].join("+");
}

export interface ShortcutDisplayParts {
  modifiers: string[];
  finalKey?: string;
  finalized: boolean;
}

// keyboard-event->display-parts: the recording view renders the modifiers
// while the user is still holding them and finalizes on the key.
export function eventToDisplayParts(event: ShortcutKeyEvent, macos: boolean): ShortcutDisplayParts {
  const modifiers = eventToModifierParts(event, macos);
  const key = event.key;
  if (key !== undefined && modifierEventKeys.has(key)) return { modifiers, finalized: false };
  return { modifiers, finalKey: normalizeKey(event) ?? undefined, finalized: true };
}

// --- Command canonicalization (mousetrap _keysFromString/_getKeyInfo) ------

const modifierOrder = ["ctrl", "command", "alt", "shift"] as const;

function isModifierToken(token: string): boolean {
  return (
    token === "ctrl" || token === "command" || token === "alt" || token === "shift" ||
    token === "meta"
  );
}

// _SPECIAL_ALIASES minus "mod" (platform-dependent, never produced by the
// app); "meta" folds into "command", the name the event side emits on mac.
const specialAliases: Record<string, string> = {
  option: "alt",
  return: "enter",
  escape: "esc",
  plus: "+",
  meta: "command",
};

function comboString(modifiers: Iterable<string>, key: string): string {
  const set = new Set(modifiers);
  const parts: string[] = [];
  for (const modifier of modifierOrder) {
    if (set.has(modifier)) parts.push(modifier);
  }
  parts.push(key);
  return parts.join("+");
}

// One "a+b+key" part -> its canonical combination(s). The lone "+" and "++"
// are handled like _keysFromString; the "+" key expands to both the literal
// plus and the US main-row form (see the header).
function canonicalCombosForPart(part: string): string[] {
  let tokens: string[];
  if (part === "+") {
    tokens = ["+"];
  } else {
    tokens = part
      .replace(/\+\+/g, "+plus")
      .split("+")
      .filter((token) => token !== "");
  }
  const modifiers = new Set<string>();
  let key: string | null = null;
  for (const raw of tokens) {
    const token = specialAliases[raw] ?? raw;
    if (isModifierToken(token)) {
      modifiers.add(token);
      continue;
    }
    key = token;
  }
  if (key === null) return [];
  if (key === "+") {
    return [comboString(modifiers, "+"), comboString([...modifiers, "shift"], "=")];
  }
  return [comboString(modifiers, key)];
}

// A mousetrap command ("alt+m", "g d", "+") -> the canonical combinations a
// keydown event can produce. Sequences keep their space separator; a part
// that expands to several combinations yields the cross product.
export function canonicalCommands(command: string | null | undefined): string[] {
  if (command === null || command === undefined || command === "") return [];
  let combos: string[] = [""];
  for (const part of command.trim().split(/\s+/)) {
    const partCombos = canonicalCombosForPart(part);
    if (partCombos.length === 0) return [];
    combos = combos.flatMap((prefix) =>
      partCombos.map((next) => (prefix === "" ? next : prefix + " " + next)),
    );
  }
  return combos;
}

// --- Matcher ---------------------------------------------------------------

export interface ShortcutBinding {
  command?: string | string[] | null;
  // Static :disabled definitions (data/workspace/shortcuts.cljs :paste) and
  // overrides cleared to "" never bind.
  disabled?: boolean;
  run: () => void;
}

// The slice of EventTarget the stop guard reads (mousetrap stopCallback).
export interface ShortcutTarget {
  tagName?: string;
  className?: string;
  contentEditable?: string | boolean;
  dataset?: { [key: string]: unknown };
}

// Mousetrap's stopCallback: shortcuts do not fire inside inputs, selects,
// textareas, contenteditable regions or (for tab combos) buttons, unless the
// element opts out with the mousetrap class or data-mousetrap-dont-stop.
export function shouldStopShortcut(target: ShortcutTarget | null | undefined, combo: string): boolean {
  if (target === null || target === undefined) return false;
  if (target.dataset !== undefined && "mousetrapDontStop" in target.dataset) return false;
  if ((" " + (target.className ?? "") + " ").indexOf(" mousetrap ") > -1) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return true;
  if (tag === "BUTTON" && combo.includes("tab")) return true;
  const editable = target.contentEditable;
  return editable === "true" || editable === "plaintext-only";
}

export interface ShortcutMatcher {
  // Feeds one keydown's canonical combination. Returns true when an action
  // ran (the caller may preventDefault, like wrap-cb in data/shortcuts.cljs).
  handle: (combo: string, target?: ShortcutTarget | null) => boolean;
  dispose: () => void;
}

const sequenceTimeout = 1000; // mousetrap _resetSequenceTimer

interface MatcherSequence {
  steps: string[];
  level: number;
  run: () => void;
}

// Keydown matcher with mousetrap's sequence semantics: sequences advance on
// each matching keydown, reset when a keydown matches none of them (only the
// longest match of an event fires, doNotReset in _handleKey) and time out
// after one second. Later bindings win for an identical canonical combo; the
// settings-side conflict flow clears collisions before they reach here.
export function createShortcutMatcher(bindings: ReadonlyArray<ShortcutBinding>): ShortcutMatcher {
  const singles = new Map<string, () => void>();
  const sequences = new Map<string, MatcherSequence>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  for (const binding of bindings) {
    if (binding.disabled === true) continue;
    const commands = Array.isArray(binding.command) ? binding.command : [binding.command ?? ""];
    for (const command of commands) {
      for (const canonical of canonicalCommands(command)) {
        if (canonical.includes(" ")) {
          sequences.set(canonical, { steps: canonical.split(" "), level: 0, run: binding.run });
        } else {
          singles.set(canonical, binding.run);
        }
      }
    }
  }

  const resetTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      for (const sequence of sequences.values()) sequence.level = 0;
    }, sequenceTimeout);
  };

  const handle = (combo: string, target?: ShortcutTarget | null): boolean => {
    if (combo === "" || isModifierToken(combo)) return false;

    let maxLevel = 0;
    for (const sequence of sequences.values()) {
      if (sequence.level < sequence.steps.length && sequence.steps[sequence.level] === combo) {
        maxLevel = Math.max(maxLevel, sequence.level + 1);
      }
    }

    let fired = false;
    let advanced = false;
    const doNotReset = new Set<string>();
    if (maxLevel > 0) {
      for (const [name, sequence] of sequences) {
        const step = sequence.level + 1;
        if (sequence.level >= sequence.steps.length || sequence.steps[sequence.level] !== combo) {
          continue;
        }
        if (step !== maxLevel) continue; // a shorter subsequence never fires
        doNotReset.add(name);
        if (step === sequence.steps.length) {
          sequence.level = 0;
          if (!shouldStopShortcut(target, combo)) {
            sequence.run();
            fired = true;
          }
        } else {
          sequence.level = step;
          advanced = true;
        }
      }
    } else {
      const single = singles.get(combo);
      if (single !== undefined && !shouldStopShortcut(target, combo)) {
        single();
        fired = true;
      }
    }

    for (const [name, sequence] of sequences) {
      if (!doNotReset.has(name)) sequence.level = 0;
    }
    if (advanced) {
      resetTimer();
    } else if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return fired;
  };

  const dispose = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return { handle, dispose };
}

// --- Overrides, index and conflict (data/shortcuts.cljs / ui/shortcuts.cljs) ---

// The [:profile :props :custom-shortcuts] value: group ("dashboard",
// "workspace", "viewer") -> shortcut key -> mousetrap command. "" disables.
export type CustomShortcuts = Record<string, Record<string, string>>;

export interface ShortcutDefinitionShape {
  command?: string | string[];
  disabled?: boolean;
  originalCommand?: string | string[];
  showCommand?: string | string[];
}

// apply-custom-overrides: replaces the command of every overridden key in one
// group, keeping the previous command as original-command and dropping
// show-command; disabled definitions are left alone.
export function applyCustomOverrides<T extends ShortcutDefinitionShape>(
  shortcuts: Record<string, T>,
  customOverrides: CustomShortcuts | null | undefined,
  groupKey: string,
): Record<string, T> {
  const groupOverrides = customOverrides?.[groupKey];
  if (groupOverrides === undefined || Object.keys(groupOverrides).length === 0) return shortcuts;
  let out = shortcuts;
  for (const [scKey, newCommand] of Object.entries(groupOverrides)) {
    const definition = out[scKey];
    if (definition === undefined || definition.disabled === true) continue;
    const next: ShortcutDefinitionShape = {
      ...definition,
      originalCommand: definition.command,
      command: newCommand,
    };
    delete next.showCommand;
    out = { ...out, [scKey]: next as T };
  }
  return out;
}

// build-command-index: command -> shortcut key over a definition map; vector
// commands (alternative bindings) index every entry.
export function buildCommandIndex(
  shortcuts: Record<string, ShortcutDefinitionShape>,
): Record<string, string> {
  const index: Record<string, string> = {};
  for (const [scKey, definition] of Object.entries(shortcuts)) {
    const commands = definition.command;
    if (Array.isArray(commands)) {
      for (const command of commands) index[command] = scKey;
    } else if (commands !== undefined) {
      index[commands] = scKey;
    }
  }
  return index;
}

export interface ShortcutConflict {
  key: string;
  labelKey: string;
}

// find-conflict: the key already bound to `newCommand`, unless it is the one
// being edited. The label is the definition's i18n key (translation-keyname
// resolves labels from the definitions; the "shortcuts.<name>" fallback covers
// keys without one).
export function findConflict(
  newCommand: string,
  allShortcuts: Record<string, ShortcutDefinitionShape & { labelKey?: string }>,
  currentKey: string,
): ShortcutConflict | null {
  const conflicting = buildCommandIndex(allShortcuts)[newCommand];
  if (conflicting === undefined || conflicting === currentKey) return null;
  return {
    key: conflicting,
    labelKey: allShortcuts[conflicting]?.labelKey ?? "shortcuts." + conflicting,
  };
}

// shortcut->command-string: the lowercase searchable form of a shortcut's
// command(s); prefers show-command, joins vector commands with spaces.
export function shortcutCommandString(shortcut: {
  command?: string | string[];
  showCommand?: string | string[];
}): string {
  const command = shortcut.showCommand ?? shortcut.command;
  if (command === null || command === undefined) return "";
  return (Array.isArray(command) ? command.join(" ") : command).toLowerCase();
}

// --- Custom shortcut transforms (dashboard/shortcuts/customize.cljs) -------

// set-custom-shortcut: stores the new command and clears the conflicting key
// in the same group ("" means disabled).
export function setCustomShortcut(
  customs: CustomShortcuts | null | undefined,
  shortcutKey: string,
  newCommand: string,
  conflictingKey: string | null | undefined,
  groupKey: string,
): CustomShortcuts {
  const current = customs ?? {};
  const existing = current[groupKey];
  const groupMap: Record<string, string> =
    existing !== undefined && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing }
      : {};
  groupMap[shortcutKey] = newCommand;
  if (conflictingKey !== null && conflictingKey !== undefined && conflictingKey !== "") {
    groupMap[conflictingKey] = "";
  }
  return { ...current, [groupKey]: groupMap };
}

// reset-custom-shortcut: drops the key's override; any other key holding the
// default command as its custom command is disabled, and an emptied group is
// removed. `defaultCommand` may be a vector (alternative bindings).
export function resetCustomShortcut(
  customs: CustomShortcuts | null | undefined,
  shortcutKey: string,
  defaultCommand: string | string[] | null | undefined,
  groupKey: string,
): CustomShortcuts {
  const current = customs ?? {};
  const existing = current[groupKey];
  const groupMap: Record<string, string> =
    existing !== undefined && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing }
      : {};

  let ownerKey: string | null = null;
  if (defaultCommand !== null && defaultCommand !== undefined && defaultCommand !== "") {
    for (const [key, value] of Object.entries(groupMap)) {
      const matches = Array.isArray(defaultCommand)
        ? defaultCommand.includes(value)
        : value === defaultCommand;
      if (matches) {
        ownerKey = key;
        break;
      }
    }
  }

  delete groupMap[shortcutKey];
  if (ownerKey !== null && ownerKey !== shortcutKey) groupMap[ownerKey] = "";

  const next: CustomShortcuts = { ...current };
  if (Object.keys(groupMap).length === 0) delete next[groupKey];
  else next[groupKey] = groupMap;
  return next;
}

// --- Profile props <-> custom shortcuts ------------------------------------

// Reads [:profile :props :custom-shortcuts]. lib/transit normalizes the
// keyword keys ("~:dashboard") to strings, so the stored and read shapes
// match; malformed entries are dropped rather than trusted.
export function customShortcutsFromProfile(
  profile: { props?: Record<string, unknown> } | null | undefined,
): CustomShortcuts {
  const raw = profile?.props?.["custom-shortcuts"];
  if (raw === null || raw === undefined || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const out: CustomShortcuts = {};
  for (const [group, entries] of Object.entries(raw as Record<string, unknown>)) {
    if (entries === null || typeof entries !== "object" || Array.isArray(entries)) continue;
    const groupMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof value === "string") groupMap[key] = value;
    }
    out[group] = groupMap;
  }
  return out;
}

// The write side: [:custom-shortcuts] is [:map-of :keyword [:map-of :keyword
// :string]] on the backend, so both key levels travel as transit keywords (a
// plain JS object would arrive with string keys and fail validation).
export function customShortcutsWire(customs: CustomShortcuts): unknown {
  const groups: Record<string, unknown> = {};
  for (const [group, entries] of Object.entries(customs)) {
    groups[group] = keywordMap(entries);
  }
  return keywordMap(groups);
}
