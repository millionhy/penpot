// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Port of the DTCG half of `app.common.types.tokens-lib`: the multi-set
// reader used by `addTokensLib` and the exporter that writes
// `files/<id>/tokens.json`. The internal tree mirrors the CLJS one, with
// `G-`/`S-` prefixed keys for set groups and sets.

import type { Uuid } from "./model.ts";
import { ZERO, next } from "./uuid.ts";
import { now } from "./files.ts";
import { withoutNils } from "./data.ts";
import { fail } from "./errors.ts";

export interface Token {
  id: Uuid;
  name: string;
  type: string;
  value: unknown;
  description: string;
  modifiedAt: string;
}

export interface TokenSet {
  id: Uuid;
  name: string;
  description: string;
  modifiedAt: string;
  tokens: Record<string, Token>;
}

export interface TokenTheme {
  id: Uuid;
  name: string;
  group: string;
  description: string;
  isSource: boolean;
  externalId: string;
  modifiedAt: string;
  sets: string[];
}

export type SetNode = TokenSet | { [name: string]: SetNode };
export type ThemeNode = TokenTheme | { [name: string]: ThemeNode };

export interface TokensLib {
  sets: Record<string, SetNode>;
  themes: Record<string, ThemeNode>;
  activeThemes: string[];
}

export const HIDDEN_THEME_ID: Uuid = ZERO;
export const HIDDEN_THEME_GROUP = "";
export const HIDDEN_THEME_NAME = "__PENPOT__HIDDEN__TOKEN__THEME__";
export const HIDDEN_THEME_PATH = `/${HIDDEN_THEME_NAME}`;

const SET_PREFIX = "S-";
const SET_GROUP_PREFIX = "G-";
const SET_SEPARATOR = "/";
const THEME_SEPARATOR = "/";

// `app.common.types.token/token-type->dtcg-token-type`.
export const TOKEN_TYPE_TO_DTCG: Readonly<Record<string, string>> = {
  boolean: "boolean",
  "border-radius": "borderRadius",
  color: "color",
  dimensions: "dimension",
  "font-family": "fontFamilies",
  "font-size": "fontSizes",
  "font-weight": "fontWeights",
  "letter-spacing": "letterSpacing",
  number: "number",
  opacity: "opacity",
  other: "other",
  rotation: "rotation",
  shadow: "shadow",
  sizing: "sizing",
  spacing: "spacing",
  string: "string",
  "stroke-width": "borderWidth",
  "text-case": "textCase",
  "text-decoration": "textDecoration",
  typography: "typography",
};

const DTCG_TO_TOKEN_TYPE: Readonly<Record<string, string>> = (() => {
  const mapping: Record<string, string> = {};
  for (const [type, dtcg] of Object.entries(TOKEN_TYPE_TO_DTCG)) {
    mapping[dtcg] = type;
  }
  // Singular spellings accepted for backward compatibility with Style
  // Dictionary exports.
  mapping.fontWeight = "font-weight";
  mapping.fontSize = "font-size";
  mapping.fontFamily = "font-family";
  mapping.boxShadow = "shadow";
  return mapping;
})();

const TYPOGRAPHY_KEYS: ReadonlySet<string> = new Set([
  "font-family",
  "font-size",
  "font-weight",
  "letter-spacing",
  "line-height",
  "text-case",
  "text-decoration",
  "typography",
]);

const COMPOSITE_DTCG_TO_TOKEN_TYPE: Readonly<Record<string, string>> =
  (() => {
    const mapping: Record<string, string> = { ...DTCG_TO_TOKEN_TYPE };
    mapping.lineHeights = "line-height";
    mapping.lineHeight = "line-height";
    for (const [key, value] of Object.entries({ ...mapping })) {
      mapping[kebabCase(key)] = value;
    }
    return mapping;
  })();

const COMPOSITE_TOKEN_TYPE_TO_DTCG: Readonly<Record<string, string>> = {
  ...TOKEN_TYPE_TO_DTCG,
  "line-height": "lineHeights",
};

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kebabCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[\s_]+/g, "-")
    .toLowerCase();
}

function assertObject(
  value: unknown,
  hint: string,
): asserts value is JsonObject {
  if (!isPlainObject(value)) {
    fail("assertion", "data-validation", hint);
  }
}

export function isTokenSet(node: unknown): node is TokenSet {
  return (
    isPlainObject(node) &&
    typeof node.id === "string" &&
    typeof node.name === "string" &&
    isPlainObject(node.tokens)
  );
}

export function isTokenTheme(node: unknown): node is TokenTheme {
  return (
    isPlainObject(node) &&
    typeof node.id === "string" &&
    typeof node.name === "string" &&
    typeof node.externalId === "string" &&
    Array.isArray(node.sets)
  );
}

export function isTokensLib(value: unknown): value is TokensLib {
  return (
    isPlainObject(value) &&
    isPlainObject(value.sets) &&
    isPlainObject(value.themes) &&
    Array.isArray(value.activeThemes)
  );
}

// === Paths

function splitPath(path: string, separator: string): string[] {
  return path
    .split(separator)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function joinPath(path: readonly string[], separator: string): string {
  return path.join(separator);
}

export function splitSetName(name: string): string[] {
  return splitPath(String(name), SET_SEPARATOR);
}

export function joinSetPath(path: readonly string[]): string {
  return joinPath(path, SET_SEPARATOR);
}

export function normalizeSetName(name: string): string {
  return joinSetPath(splitSetName(String(name)));
}

function setFullPathToPrefixedFullPath(fullPath: readonly string[]): string[] {
  return [
    ...fullPath.slice(0, -1).map((item) => SET_GROUP_PREFIX + item),
    SET_PREFIX + (fullPath[fullPath.length - 1] ?? ""),
  ];
}

export function setNameToPrefixedFullPath(name: string): string[] {
  return setFullPathToPrefixedFullPath(splitSetName(name));
}

export function setGroupPathToPrefixedPath(
  path: readonly string[],
): string[] {
  return path.map((item) => SET_GROUP_PREFIX + item);
}

export function getSetPath(tokenSet: TokenSet): string[] {
  return splitSetName(tokenSet.name);
}

export function getThemePath(theme: TokenTheme, withSpaces = false): string {
  const path =
    theme.group === "" && withSpaces
      ? [theme.name]
      : [theme.group, theme.name];
  return joinPath(path, withSpaces ? ` ${THEME_SEPARATOR} ` : THEME_SEPARATOR);
}

export function splitThemePath(path: string): [string, string] {
  const segments = splitPath(path, THEME_SEPARATOR);
  const group = joinPath(segments.slice(0, -1), THEME_SEPARATOR);
  return [group, segments[segments.length - 1] ?? ""];
}

export function isHiddenTheme(theme: TokenTheme): boolean {
  return theme.group === HIDDEN_THEME_GROUP && theme.name === HIDDEN_THEME_NAME;
}

// === Immutable tree helpers

function getIn(tree: unknown, path: readonly string[]): unknown {
  let node: unknown = tree;
  for (const key of path) {
    if (!isPlainObject(node)) return undefined;
    node = node[key];
  }
  return node;
}

function assocIn(
  tree: JsonObject,
  path: readonly string[],
  value: unknown,
): JsonObject {
  if (path.length === 0) return tree;
  const [key, ...rest] = path as [string, ...string[]];
  if (rest.length === 0) {
    return { ...tree, [key]: value };
  }
  const child = isPlainObject(tree[key]) ? (tree[key] as JsonObject) : {};
  return { ...tree, [key]: assocIn(child, rest, value) };
}

function dissocIn(tree: JsonObject, path: readonly string[]): JsonObject {
  if (path.length === 0) return tree;
  const [key, ...rest] = path as [string, ...string[]];
  if (rest.length === 0) {
    const result = { ...tree };
    delete result[key];
    return result;
  }
  if (!isPlainObject(tree[key])) return tree;
  return {
    ...tree,
    [key]: dissocIn(tree[key] as JsonObject, rest),
  };
}

// Depth-first walk in insertion order, matching `tree-seq` over the ordered
// maps the CLJS library builds.
export function collectSets(sets: Record<string, SetNode>): TokenSet[] {
  const result: TokenSet[] = [];
  for (const node of Object.values(sets)) {
    if (isTokenSet(node)) result.push(node);
    else result.push(...collectSets(node));
  }
  return result;
}

export function collectThemes(themes: Record<string, ThemeNode>): TokenTheme[] {
  const result: TokenTheme[] = [];
  for (const node of Object.values(themes)) {
    if (isTokenTheme(node)) result.push(node);
    else result.push(...collectThemes(node));
  }
  return result;
}

// === Constructors

export interface TokenAttrs {
  id?: Uuid;
  name: string;
  type: string;
  value: unknown;
  description?: string;
  modifiedAt?: string;
}

export function makeToken(attrs: TokenAttrs): Token {
  return {
    id: attrs.id ?? next(),
    name: attrs.name,
    type: attrs.type,
    value: attrs.value,
    description: attrs.description ?? "",
    modifiedAt: attrs.modifiedAt ?? now(),
  };
}

export interface TokenSetAttrs {
  id?: Uuid;
  name: string;
  description?: string;
  modifiedAt?: string;
  tokens?: Record<string, Token>;
}

export function makeTokenSet(attrs: TokenSetAttrs): TokenSet {
  return {
    id: attrs.id ?? next(),
    name: normalizeSetName(attrs.name),
    description: attrs.description ?? "",
    modifiedAt: attrs.modifiedAt ?? now(),
    tokens: { ...(attrs.tokens ?? {}) },
  };
}

export interface TokenThemeAttrs {
  id?: Uuid | string;
  name: string;
  group?: string;
  description?: string;
  isSource?: boolean;
  externalId?: string;
  modifiedAt?: string;
  sets?: readonly string[];
}

function parseThemeId(id: Uuid | string | undefined): Uuid {
  if (typeof id === "string") {
    const parsed = /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null;
    if (parsed != null) return parsed;
  }
  return next();
}

export function makeTokenTheme(attrs: TokenThemeAttrs): TokenTheme {
  const id = parseThemeId(attrs.id);
  const sets: string[] = [];
  for (const item of attrs.sets ?? []) {
    if (item == null) continue;
    const normalized = normalizeSetName(String(item));
    if (!sets.includes(normalized)) sets.push(normalized);
  }

  return {
    id,
    name: attrs.name,
    group: attrs.group ?? HIDDEN_THEME_GROUP,
    description: attrs.description ?? "",
    isSource: attrs.isSource ?? false,
    externalId: attrs.externalId ?? id,
    modifiedAt: attrs.modifiedAt ?? now(),
    sets,
  };
}

export function makeHiddenTheme(): TokenTheme {
  return makeTokenTheme({
    id: HIDDEN_THEME_ID,
    externalId: "",
    group: HIDDEN_THEME_GROUP,
    name: HIDDEN_THEME_NAME,
    sets: [],
  });
}

export function makeTokensLib(): TokensLib {
  const hidden = makeHiddenTheme();
  return {
    sets: {},
    themes: { [HIDDEN_THEME_GROUP]: { [HIDDEN_THEME_NAME]: hidden } },
    activeThemes: [HIDDEN_THEME_PATH],
  };
}

// === Collection operations

export function addSet(lib: TokensLib, tokenSet: TokenSet): TokensLib {
  const path = setNameToPrefixedFullPath(tokenSet.name);
  return { ...lib, sets: assocIn(lib.sets, path, tokenSet) as Record<string, SetNode> };
}

export function addTheme(lib: TokensLib, theme: TokenTheme): TokensLib {
  return {
    ...lib,
    themes: assocIn(lib.themes, [theme.group, theme.name], theme) as Record<
      string,
      ThemeNode
    >,
  };
}

export function getSets(lib: TokensLib): TokenSet[] {
  return collectSets(lib.sets);
}

export function getThemes(lib: TokensLib): TokenTheme[] {
  return collectThemes(lib.themes);
}

export function getSetNames(lib: TokensLib): string[] {
  return getSets(lib).map((tokenSet) => tokenSet.name);
}

export function getTheme(lib: TokensLib, id: Uuid): TokenTheme | undefined {
  return getThemes(lib).find((theme) => theme.id === id);
}

export function getThemeByName(
  lib: TokensLib,
  group: string,
  name: string,
): TokenTheme | undefined {
  const node = getIn(lib.themes, [group, name]);
  return isTokenTheme(node) ? node : undefined;
}

export function updateTheme(
  lib: TokensLib,
  id: Uuid,
  f: (theme: TokenTheme) => TokenTheme,
): TokensLib {
  const theme = getTheme(lib, id);
  if (theme == null) return lib;

  const updated = { ...f(theme), modifiedAt: now() };
  const samePath =
    updated.group === theme.group && updated.name === theme.name;

  let themes: Record<string, ThemeNode>;
  if (samePath) {
    themes = assocIn(
      lib.themes,
      [theme.group, theme.name],
      updated,
    ) as Record<string, ThemeNode>;
  } else {
    themes = assocIn(
      dissocIn(lib.themes, [theme.group, theme.name]),
      [updated.group, updated.name],
      updated,
    ) as Record<string, ThemeNode>;
  }

  const activeThemes = samePath
    ? lib.activeThemes
    : lib.activeThemes.filter((path) => path !== getThemePath(theme));

  return { ...lib, themes, activeThemes };
}

export function emptyLib(lib: TokensLib): boolean {
  if (getSets(lib).length > 0) return false;
  const themes = getThemes(lib);
  if (themes.length === 0) return true;
  return themes.length === 1 && themes[0]?.id === HIDDEN_THEME_ID;
}

// === DTCG import

export function convertDtcgFontFamily(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return value;
}

export function convertDtcgTypographyComposite(
  value: unknown,
): unknown {
  if (!isPlainObject(value)) return value;

  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    const internal = COMPOSITE_DTCG_TO_TOKEN_TYPE[key];
    if (internal == null || !TYPOGRAPHY_KEYS.has(internal)) continue;
    result[internal] =
      internal === "font-family" ? convertDtcgFontFamily(item) : item;
  }
  return result;
}

function convertDtcgShadow(value: unknown): unknown {
  const processShadow = (shadow: unknown): unknown => {
    if (!isPlainObject(shadow)) return shadow;

    const inset = shadow.inset;
    const insetValue =
      typeof inset === "boolean"
        ? inset
        : inset === "true"
          ? true
          : inset === "false"
            ? false
            : shadow.type === "innerShadow";

    const result: JsonObject = { inset: insetValue };
    const offsetX = shadow.offsetX ?? shadow.x;
    const offsetY = shadow.offsetY ?? shadow.y;
    if (offsetX !== undefined) result["offset-x"] = offsetX;
    if (offsetY !== undefined) result["offset-y"] = offsetY;
    if (shadow.blur !== undefined) result.blur = shadow.blur;
    if (shadow.spread !== undefined) result.spread = shadow.spread;
    if (shadow.color !== undefined) result.color = shadow.color;
    return result;
  };

  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(processShadow);
  if (isPlainObject(value)) return [processShadow(value)];
  return value;
}

function convertDtcgValue(type: string, value: unknown): unknown {
  if (type === "font-family") return convertDtcgFontFamily(value);
  if (type === "typography") return convertDtcgTypographyComposite(value);
  if (type === "shadow") return convertDtcgShadow(value);
  return value;
}

export function flattenNestedTokens(
  node: JsonObject,
  parentPath = "",
  inheritedType: string | undefined = undefined,
  result: Record<string, Token> = {},
): Record<string, Token> {
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;

    const childPath = parentPath === "" ? key : `${parentPath}.${key}`;
    if (!isPlainObject(value)) continue;

    const declaredType =
      typeof value.$type === "string" ? value.$type : undefined;

    if (!("$value" in value)) {
      flattenNestedTokens(
        value,
        childPath,
        declaredType ?? inheritedType,
        result,
      );
      continue;
    }

    const dtcgType = declaredType ?? inheritedType;
    const type = dtcgType == null ? undefined : DTCG_TO_TOKEN_TYPE[dtcgType];
    if (type == null) continue;

    result[childPath] = makeToken({
      name: childPath,
      type,
      value: convertDtcgValue(type, value.$value),
      description:
        typeof value.$description === "string"
          ? value.$description
          : undefined,
    });
  }
  return result;
}

interface ThemeNodeInput {
  id?: string;
  name: string;
  group?: string;
  isSource?: boolean;
  "is-source"?: boolean;
  selectedTokenSets: Record<string, string>;
}

function checkMultiSetDtcg(data: JsonObject): void {
  const themes = data.$themes;
  if (themes !== undefined) {
    if (!Array.isArray(themes)) {
      fail("assertion", "data-validation", "expected a vector for `$themes`");
    }
    for (const theme of themes) {
      if (!isPlainObject(theme) || typeof theme.name !== "string") {
        fail("assertion", "data-validation", "expected a valid theme");
      }
      if (!isPlainObject(theme.selectedTokenSets)) {
        fail(
          "assertion",
          "data-validation",
          "expected a map for `selectedTokenSets`",
        );
      }
    }
  }

  const metadata = data.$metadata;
  if (metadata !== undefined) {
    if (!isPlainObject(metadata)) {
      fail("assertion", "data-validation", "expected a map for `$metadata`");
    }
    for (const key of ["tokenSetOrder", "activeThemes", "activeSets"]) {
      const value = metadata[key];
      if (value === undefined) continue;
      if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        fail(
          "assertion",
          "data-validation",
          `expected a vector of strings for \`${key}\``,
        );
      }
    }
  }

  for (const [key, value] of Object.entries(data)) {
    if (key === "$themes" || key === "$metadata") continue;
    if (!isPlainObject(value)) {
      fail(
        "assertion",
        "data-validation",
        "expected a plain object for `decoded-json`",
      );
    }
  }
}

export function parseMultiSetDtcg(data: JsonObject): TokensLib {
  checkMultiSetDtcg(data);

  const metadata = isPlainObject(data.$metadata) ? data.$metadata : {};
  const themeInputs: ThemeNodeInput[] = Array.isArray(data.$themes)
    ? (data.$themes as ThemeNodeInput[])
    : [];

  const setsData: Record<string, JsonObject> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key === "$themes" || key === "$metadata") continue;
    setsData[key] = value as JsonObject;
  }

  const orderedSetNames: string[] = [];
  const addOrdered = (name: string) => {
    const normalized = normalizeSetName(name);
    if (!orderedSetNames.includes(normalized)) orderedSetNames.push(normalized);
  };
  if (Array.isArray(metadata.tokenSetOrder)) {
    for (const name of metadata.tokenSetOrder) addOrdered(String(name));
  }
  for (const name of Object.keys(setsData)) addOrdered(name);

  const activeSetNames: string[] = [];
  if (Array.isArray(metadata.activeSets)) {
    for (const name of metadata.activeSets) {
      const normalized = normalizeSetName(String(name));
      if (!activeSetNames.includes(normalized)) activeSetNames.push(normalized);
    }
  }

  const activeThemeNames: string[] =
    Array.isArray(metadata.activeThemes) && metadata.activeThemes.length > 0
      ? metadata.activeThemes.map(String)
      : [HIDDEN_THEME_PATH];

  const themes = themeInputs.map((theme) => {
    const sets: string[] = [];
    for (const name of Object.keys(theme.selectedTokenSets ?? {})) {
      const normalized = normalizeSetName(name);
      if (
        orderedSetNames.includes(normalized) &&
        !sets.includes(normalized)
      ) {
        sets.push(normalized);
      }
    }
    // The CLJS reader never passes `:description`, so an imported theme
    // starts with an empty one, whatever the document says.
    return makeTokenTheme({
      id: theme.id,
      name: theme.name,
      group: theme.group,
      isSource: theme.isSource ?? theme["is-source"],
      externalId: theme.id,
      sets,
    });
  });

  let lib = makeTokensLib();

  const flatSets: Record<string, Record<string, Token>> = {};
  for (const [name, tokens] of Object.entries(setsData)) {
    flatSets[normalizeSetName(name)] = flattenNestedTokens(tokens);
  }

  for (const name of orderedSetNames) {
    const tokens = flatSets[name];
    if (tokens != null) lib = addSet(lib, makeTokenSet({ name, tokens }));
  }

  lib = updateTheme(lib, HIDDEN_THEME_ID, (theme) => ({
    ...theme,
    sets: activeSetNames,
  }));

  for (const theme of themes) {
    lib = addTheme(lib, theme);
  }

  for (const path of activeThemeNames) {
    const [group, name] = splitThemePath(path);
    const theme = getThemeByName(lib, group, name);
    if (theme == null) continue;

    const groupThemes = getThemes(lib)
      .filter((item) => item.group === group)
      .map((item) => getThemePath(item));
    const activeThemes = lib.activeThemes.filter(
      (item) => !groupThemes.includes(item),
    );
    if (!activeThemes.includes(getThemePath(theme))) {
      activeThemes.push(getThemePath(theme));
    }
    lib = { ...lib, activeThemes };
  }

  if (Object.keys(setsData).length === 0 && themes.length === 0) {
    // The CLJS reader throws a plain `ex-info` here, which the builder turns
    // into an `unknown`/`unknown` BuilderError.
    fail(
      "unknown",
      "unknown",
      "the file doesn't contain any tokens",
    );
  }

  return lib;
}

export function readMultiSetDtcg(data: unknown): TokensLib {
  if (isTokensLib(data)) return data;

  let decoded: unknown = data;
  if (typeof data === "string") {
    try {
      decoded = JSON.parse(data);
    } catch {
      fail("assertion", "data-validation", "expected a valid json string");
    }
  }

  assertObject(decoded, "expected a plain object for `decoded-json`");
  return parseMultiSetDtcg(decoded);
}

// === DTCG export

export function tokensTree(
  tokens: Record<string, Token>,
  updateToken: (token: Token) => unknown = (token) => token,
): JsonObject {
  let tree: JsonObject = {};
  for (const token of Object.values(tokens)) {
    tree = assocIn(
      tree,
      splitPath(token.name, "."),
      updateToken(token),
    );
  }
  return tree;
}

function typographyValueToDtcg(value: unknown): unknown {
  if (!isPlainObject(value)) return value;

  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (!TYPOGRAPHY_KEYS.has(key)) continue;
    result[COMPOSITE_TOKEN_TYPE_TO_DTCG[key] ?? key] = item;
  }
  return result;
}

function shadowValueToDtcg(value: unknown): unknown {
  if (!Array.isArray(value)) return value;

  return value.map((shadow) => {
    if (!isPlainObject(shadow)) return shadow;

    const result: JsonObject = {};
    const mapping: [string, string][] = [
      ["offset-x", "offsetX"],
      ["offset-y", "offsetY"],
      ["blur", "blur"],
      ["spread", "spread"],
      ["color", "color"],
      ["inset", "inset"],
    ];
    for (const [internal, dtcg] of mapping) {
      if (shadow[internal] !== undefined) {
        result[dtcg] = shadow[internal];
      }
    }
    return result;
  });
}

export function tokenToDtcg(token: Token): JsonObject {
  let value = token.value;
  if (token.type === "typography") value = typographyValueToDtcg(value);
  if (token.type === "shadow") value = shadowValueToDtcg(value);

  const result: JsonObject = {
    $value: value,
    $type: TOKEN_TYPE_TO_DTCG[token.type] ?? token.type,
  };
  if (token.description !== undefined) {
    result.$description = token.description;
  }
  return result;
}

export function exportDtcgThemes(
  lib: TokensLib,
): [JsonObject[], string[]] {
  const themes = getThemes(lib)
    .filter((theme) => !isHiddenTheme(theme))
    .map((theme) =>
      withoutNils({
        id: theme.externalId,
        name: theme.name,
        group: theme.group,
        description: theme.description,
        isSource: theme.isSource,
        selectedTokenSets: Object.fromEntries(
          theme.sets.map((name) => [name, "enabled"]),
        ),
      }),
    );

  const activeThemes = lib.activeThemes.filter(
    (path) => path !== HIDDEN_THEME_PATH,
  );

  return [themes, activeThemes];
}

export function exportDtcgJson(lib: TokensLib): JsonObject | null {
  if (emptyLib(lib)) return null;

  const [themes, activeThemes] = exportDtcgThemes(lib);
  const sets = getSets(lib);

  const result: JsonObject = {};
  for (const tokenSet of sets) {
    result[tokenSet.name] = tokensTree(tokenSet.tokens, tokenToDtcg);
  }

  const activeSets: string[] = [];
  for (const theme of getThemes(lib)) {
    if (!lib.activeThemes.includes(getThemePath(theme))) continue;
    for (const name of theme.sets) {
      if (!activeSets.includes(name)) activeSets.push(name);
    }
  }

  result.$themes = themes;
  result.$metadata = {
    tokenSetOrder: sets.map((tokenSet) => tokenSet.name),
    activeThemes,
    activeSets,
  };

  return result;
}
