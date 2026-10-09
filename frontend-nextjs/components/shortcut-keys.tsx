"use client";

// Shortcut keycaps (F5.6). Port of converted-chars* and shortcuts-keys* in
// app.main.ui.shortcuts: renders the tokens of a mousetrap command as
// keycaps, with the platform substitutions applied in order (arrows first,
// then the mac glyphs of command/option/delete/shift/control/esc/enter).
//
// Deviations from the CLJS original, documented:
// - The CLJS loop compares chars and penultimate with not= over vectors; a
//   fresh JS array never equals another with ===, so the comparison is
//   spelled out element-wise (sameChars).
// - A null, undefined or empty-string command yields no tokens, matching
//   clojure.string/split over it.

import { Fragment } from "react";
import { tr } from "@/lib/i18n";
import {
  downArrow,
  leftArrow,
  macCommand,
  macControl,
  macDelete,
  macEnter,
  macEsc,
  macOption,
  macShift,
  rightArrow,
  splitSc,
  upArrow,
} from "@/lib/shortcuts";

const modifiedKeys: Record<string, string> = {
  up: upArrow,
  down: downArrow,
  left: leftArrow,
  right: rightArrow,
  plus: "+",
};

const macosKeys: Record<string, string> = {
  command: macCommand,
  option: macOption,
  alt: macOption,
  delete: macDelete,
  del: macDelete,
  shift: macShift,
  control: macControl,
  esc: macEsc,
  enter: macEnter,
};

// converted-chars*: the modified-key table first, then the mac table over
// the substituted value, like the two let rebinds of the CLJS.
export function convertedChar(char: string, macos: boolean): string {
  const modified = modifiedKeys[char] ?? char;
  return macos ? macosKeys[modified] ?? modified : modified;
}

// not= on the CLJS vectors; b is the penultimate token list (null when the
// command has a single binding).
function sameChars(a: readonly string[], b: readonly string[] | null): boolean {
  if (b === null || a.length !== b.length) return false;
  return a.every((value, index) => value === b[index]);
}

// split-sc over one entry: an unbound (null) or disabled ("") command yields
// no tokens, and so does the empty string, like clojure.string/split does.
function splitChars(entry: string | null | undefined): string[] {
  if (entry === null || entry === undefined || entry === "") return [];
  return splitSc(entry);
}

export interface ShortcutKeysProps {
  // A single command or the vector of alternative bindings.
  content: string | readonly string[] | null | undefined;
  // The shortcut key, part of the react (and CLJS) per-char key.
  command: string;
  macos: boolean;
  // Overrides the variant class (the restore table passes its own).
  keyClassName?: string;
  customized?: boolean;
  conflict?: boolean;
  light?: boolean;
}

export function ShortcutKeys({
  content,
  command,
  macos,
  keyClassName,
  customized,
  conflict,
  light,
}: ShortcutKeysProps) {
  const managedList = Array.isArray(content) ? content : [content];
  const charsList = managedList.map(splitChars);
  const lastElement = charsList[charsList.length - 1] ?? null;
  const shortCharList = charsList.length <= 1 ? charsList : charsList.slice(0, -1);
  const penultimate = shortCharList[shortCharList.length - 1] ?? null;

  const variantClass =
    keyClassName ??
    (conflict === true
      ? "pp-shortcut-key-conflict"
      : customized === true
        ? "pp-shortcut-key-customized"
        : light === true
          ? "pp-shortcut-key-light"
          : "");
  const variantSuffix = variantClass === "" ? "" : " " + variantClass;

  const renderChar = (char: string, index: number, position: string) => (
    <span
      className={"pp-shortcut-key" + variantSuffix}
      key={char + "-" + command + "-" + position + "-" + index}
    >
      {convertedChar(char, macos)}
    </span>
  );

  return (
    <span className="pp-shortcut-keys">
      {shortCharList.map((chars, index) => (
        <Fragment key={chars.join("") + "-" + index}>
          {chars.map((char, charIndex) => renderChar(char, charIndex, "short"))}
          {sameChars(chars, penultimate) ? null : <span className="pp-shortcut-space">,</span>}
        </Fragment>
      ))}
      {lastElement !== null && !sameChars(lastElement, penultimate) ? (
        <Fragment>
          <span className="pp-shortcut-space">{tr("shortcuts.or")}</span>
          {lastElement.map((char, charIndex) => renderChar(char, charIndex, "last"))}
        </Fragment>
      ) : null}
    </span>
  );
}
