// app.common.fonts, Node side: the font-id -> wasm-uuid mapping the text
// serializer needs, built from the bundled google-fonts catalog.
//
// The CLJS build inlines the catalog with random per-family uuids at compile
// time (`preload-gfonts`). The TS port does the same at runtime: each family
// gets one uuid per process, and both the serializer (id -> uuid) and the font
// provisioning (`uuid -> catalog entry`) read this same table, so the two stay
// consistent without depending on a particular build.
//
// The catalog is loaded lazily from the repository copy; a deployment must ship
// it next to `resources/wasm` (G2.7). A missing file degrades google fonts to
// the default family, with a warning, instead of failing the export.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { createLogger } from "./logging.js";
import { next as nextUuid, isUuid, zero } from "./uuid.js";

const log = createLogger("app.fonts");

export const customPrefix = "custom-";
export const gfontPrefix = "gfont-";
export const gfontsFile = "gfonts.2025.11.28.json";

export interface GFontVariant {
  id: string;
  name: string;
  weight: number;
  style: string;
  "ttf-url": string | undefined;
}

export interface GFont {
  id: string;
  uuid: string;
  family: string;
  variants: GFontVariant[];
}

interface RawGFont {
  family: string;
  variants: string[];
  files: Record<string, string>;
}

export type FontBackend = "google" | "custom" | "builtin";

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

function parseVariant(variant: string, files: Record<string, string>): GFontVariant | undefined {
  if (variant === "regular") {
    return { id: "regular", name: "400", weight: 400, style: "normal", "ttf-url": files.regular };
  }

  if (variant === "italic") {
    return { id: "italic", name: "400 Italic", weight: 400, style: "italic", "ttf-url": files.italic };
  }

  const match = /^(\d+)(.*)$/.exec(variant);
  if (match === null) return undefined;

  const [, weight, style] = match;
  return {
    id: weight,
    name: `${weight} ${capitalize(style)}`.trim(),
    weight: Number.parseInt(weight, 10),
    style: style === "" ? "normal" : style,
    "ttf-url": files[weight],
  };
}

function catalogPath(): string | undefined {
  const configured = process.env.PENPOT_GFONTS_FILE;
  if (configured !== undefined && configured !== "" && existsSync(configured)) return configured;

  const candidates = [
    path.resolve("common/resources/fonts", gfontsFile),
    path.resolve("../common/resources/fonts", gfontsFile),
    path.resolve("resources/fonts", gfontsFile),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

export function buildCatalog(raw: readonly RawGFont[]): Map<string, GFont> {
  const byId = new Map<string, GFont>();
  for (const font of raw) {
    const id = `${gfontPrefix}${slug(font.family)}`;
    const variants = font.variants
      .map((variant) => parseVariant(variant, font.files))
      .filter((variant): variant is GFontVariant => variant !== undefined);
    byId.set(id, { id, uuid: nextUuid(), family: font.family, variants });
  }
  return byId;
}

let catalog: Map<string, GFont> | undefined;
let warned = false;

export function setCatalog(entries: Map<string, GFont> | undefined): void {
  catalog = entries;
}

function ensureCatalog(): Map<string, GFont> | undefined {
  if (catalog !== undefined) return catalog;

  const file = catalogPath();
  if (file === undefined) {
    if (!warned) {
      warned = true;
      log.warn({ hint: "google fonts catalog not found; google fonts fall back to the default family" });
    }
    return undefined;
  }

  const raw = JSON.parse(readFileSync(file, "utf-8")) as { items?: RawGFont[] };
  catalog = buildCatalog(raw.items ?? []);
  return catalog;
}

export function gfont(id: string): GFont | undefined {
  return ensureCatalog()?.get(id);
}

export function gfontIdToUuid(gfontId: string): string | undefined {
  return gfont(gfontId)?.uuid;
}

export function fontIdBackend(fontId: unknown): FontBackend {
  if (typeof fontId !== "string") return "builtin";
  if (fontId.startsWith(gfontPrefix)) return "google";
  if (fontId.startsWith(customPrefix)) return "custom";
  return "builtin";
}

// gfont-<slug> -> the catalog uuid, custom-<uuid> -> that uuid, anything else
// (builtin, unknown, malformed) -> uuid/zero, which wasm resolves to the
// default font.
export function fontIdToUuid(fontId: unknown): string {
  switch (fontIdBackend(fontId)) {
    case "google": {
      const id = fontId as string;
      return gfontIdToUuid(id) ?? zero;
    }
    case "custom": {
      const suffix = (fontId as string).slice(customPrefix.length);
      return isUuid(suffix) ? suffix.toLowerCase() : zero;
    }
    default:
      return zero;
  }
}

// --- reverse catalog lookup

let byUuid: Map<string, GFont> | undefined;
let byUuidOf: Map<string, GFont> | undefined;

// The catalog entry a uuid belongs to, which is how font provisioning turns the
// quartet `_get_fonts_for_shape` reports back into a download URL.
export function gfontByUuid(fontUuid: string): GFont | undefined {
  const current = ensureCatalog();
  if (current === undefined) return undefined;

  if (byUuid === undefined || byUuidOf !== current) {
    byUuid = new Map();
    for (const font of current.values()) byUuid.set(font.uuid, font);
    byUuidOf = current;
  }

  return byUuid.get(fontUuid);
}

// --- proxy urls

const gstaticPrefix = "https://fonts.gstatic.com/s";

// gstatic->proxy-url: point a gstatic url at the backend's font proxy.
export function gstaticToProxyUrl(source: string, base: string): string {
  return String(source).split(gstaticPrefix).join(base.replace(/\/+$/, ""));
}

// --- variant resolution

interface VariantLike {
  weight: number | string;
  style: string;
  "ttf-url"?: string | undefined;
}

function parseWeight(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isInteger(value) ? value : Math.trunc(value);
  const parsed = Number.parseInt(String(value), 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

// closest-variant: same weight and style first, then the nearest weight,
// preferring the heavier variant on a tie.
export function closestVariant<V extends VariantLike>(
  variants: readonly V[],
  targetWeight: unknown,
  targetStyle: string,
): V | undefined {
  const target = parseWeight(targetWeight);
  if (target === undefined) return undefined;

  let closest: { variant: V; weight: number; distance: number } | undefined;

  for (const variant of variants) {
    const weight = parseWeight(variant.weight);
    if (weight === undefined) continue;

    const distance = Math.abs(target - weight);
    const matchesStyle = targetStyle === "" || targetStyle === variant.style;
    const current = { variant, weight, distance };

    if (distance === 0 && matchesStyle) return variant;
    if (closest === undefined) {
      closest = current;
    } else if (
      distance < closest.distance ||
      (distance === closest.distance && weight > closest.weight)
    ) {
      closest = current;
    } else if (weight === closest.weight && targetStyle === variant.style) {
      closest = current;
    }
  }

  return closest?.variant;
}

// resolve-ttf-url: the catalog TTF for the requested weight/style, falling back
// to the family's first variant.
export function resolveTtfUrl(
  fontUuid: string,
  weight: number,
  style: number,
): string | undefined {
  const font = gfontByUuid(fontUuid);
  if (font === undefined) return undefined;

  const variant =
    closestVariant(font.variants, weight, style === 0 ? "normal" : "italic") ?? font.variants[0];
  return variant?.["ttf-url"];
}

// --- BUILTIN FONTS
//
// The family bundled with the frontend, served from `<public-uri>/fonts/`. It
// resolves by the same nearest-weight rule as the google catalog.

export const localFonts: readonly GFont[] = [
  {
    id: "sourcesanspro",
    uuid: zero,
    family: "Source Sans Pro",
    variants: [
      { id: "200", name: "200", weight: 200, style: "normal", "ttf-url": "sourcesanspro-extralight.ttf" },
      { id: "200italic", name: "200 Italic", weight: 200, style: "italic", "ttf-url": "sourcesanspro-extralightitalic.ttf" },
      { id: "300", name: "300", weight: 300, style: "normal", "ttf-url": "sourcesanspro-light.ttf" },
      { id: "300italic", name: "300 Italic", weight: 300, style: "italic", "ttf-url": "sourcesanspro-lightitalic.ttf" },
      { id: "regular", name: "400", weight: 400, style: "normal", "ttf-url": "sourcesanspro-regular.ttf" },
      { id: "italic", name: "400 Italic", weight: 400, style: "italic", "ttf-url": "sourcesanspro-italic.ttf" },
      { id: "600", name: "600", weight: 600, style: "normal", "ttf-url": "sourcesanspro-semibold.ttf" },
      { id: "600italic", name: "600 Italic", weight: 600, style: "italic", "ttf-url": "sourcesanspro-semibolditalic.ttf" },
      { id: "bold", name: "700", weight: 700, style: "normal", "ttf-url": "sourcesanspro-bold.ttf" },
      { id: "bolditalic", name: "700 Italic", weight: 700, style: "italic", "ttf-url": "sourcesanspro-bolditalic.ttf" },
      { id: "black", name: "900", weight: 900, style: "normal", "ttf-url": "sourcesanspro-black.ttf" },
      { id: "blackitalic", name: "900 Italic", weight: 900, style: "italic", "ttf-url": "sourcesanspro-blackitalic.ttf" },
    ],
  },
];

// resolve-ttf-file: builtin TTF file name for `weight` and `style`.
export function resolveTtfFile(weight: number, style: number): string | undefined {
  const variants = localFonts[0].variants;
  const variant =
    closestVariant(variants, weight, style === 0 ? "normal" : "italic") ?? variants[0];
  return variant?.["ttf-url"];
}

// --- FALLBACK FONTS
//
// Emoji and non-latin scripts render through fallback families that no span
// names, so provisioning has to derive them from the text itself.

export interface FallbackFont {
  "font-id": string;
  "font-variant-id": string;
  style: number;
  weight: number;
  "is-emoji"?: boolean;
  "is-fallback": true;
}

const emojiPattern =
  /(?:\uD83C[\uDDE6-\uDDFF]\uD83C[\uDDE6-\uDDFF])|(?:\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDEFF])|(?:\uD83E[\uDD00-\uDDFF])|(?:\uD83D[\uDE80-\uDEFF]|\uD83E[\uDC00-\uDCFF])|(?:\uD83E[\uDE70-\uDFFF])|[\u2600-\u26FF\u2700-\u27BF\u2300-\u23FF\u2B00-\u2BFF]/;

const unicodeRanges: Record<string, RegExp> = {
  japanese: /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/,
  chinese: /[\u4E00-\u9FFF\u3400-\u4DBF]/,
  korean: /[\uAC00-\uD7AF]/,
  arabic: /[\u0600-\u06FF\u0750-\u077F\u0870-\u089F\u08A0-\u08FF]/,
  cyrillic: /[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F]/,
  greek: /[\u0370-\u03FF\u1F00-\u1FFF]/,
  hebrew: /[\u0590-\u05FF\uFB1D-\uFB4F]/,
  thai: /[\u0E00-\u0E7F]/,
  devanagari: /[\u0900-\u097F\uA8E0-\uA8FF]/,
  tamil: /[\u0B80-\u0BFF]/,
  "latin-ext": /[\u0100-\u017F\u0180-\u024F]/,
  vietnamese: /[\u1EA0-\u1EF9]/,
  armenian: /[\u0530-\u058F\uFB13-\uFB17]/,
  bengali: /[\u0980-\u09FF]/,
  cherokee: /[\u13A0-\u13FF]/,
  ethiopic: /[\u1200-\u137F]/,
  georgian: /[\u10A0-\u10FF]/,
  gujarati: /[\u0A80-\u0AFF]/,
  gurmukhi: /[\u0A00-\u0A7F]/,
  khmer: /[\u1780-\u17FF\u19E0-\u19FF]/,
  lao: /[\u0E80-\u0EFF]/,
  malayalam: /[\u0D00-\u0D7F]/,
  myanmar: /[\u1000-\u109F\uAA60-\uAA7F]/,
  sinhala: /[\u0D80-\u0DFF]/,
  telugu: /[\u0C00-\u0C7F]/,
  tibetan: /[\u0F00-\u0FFF]/,
  javanese: /[\uA980-\uA9DF]/,
  kannada: /[\u0C80-\u0CFF]/,
  oriya: /[\u0B00-\u0B7F]/,
  mongolian: /[\u1800-\u18AF]/,
  syriac: /[\u0700-\u074F]/,
  tifinagh: /[\u2D30-\u2D7F]/,
  coptic: /[\u2C80-\u2CFF]/,
  "ol-chiki": /[\u1C50-\u1C7F]/,
  vai: /[\uA500-\uA63F]/,
  shavian: /\uD801[\uDC50-\uDC7F]/,
  osmanya: /\uD801[\uDC80-\uDCAF]/,
  runic: /[\u16A0-\u16FF]/,
  "old-italic": /\uD800[\uDF00-\uDF2F]/,
  brahmi: /\uD804[\uDC00-\uDC7F]/,
  modi: /\uD805[\uDE00-\uDE5F]/,
  "sora-sompeng": /\uD804[\uDCD0-\uDCFF]/,
  bamum: /[\uA6A0-\uA6FF]/,
  meroitic: /\uD802[\uDD80-\uDD9F]/,
  symbols: /[\u2190-\u21FF\u2200-\u22FF\u2300-\u23FF\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF\u2B00-\u2BFF]/,
  "symbols-2": /[\u2190-\u21FF\u2200-\u22FF\u2300-\u23FF\u25A0-\u25FF\u2600-\u26FF\u2700-\u27BF\u2B00-\u2BFF]|\uD83C[\uDC00-\uDCFF]|\uD83E[\uDC00-\uDCFF\uDF00-\uDFFF]/,
  music: /[\u2669-\u267B]|\uD834[\uDD00-\uDD1F]/,
};

export function containsEmoji(text: string): boolean {
  return emojiPattern.test(text);
}

export function collectUsedLanguages(used: Set<string>, text: string): Set<string> {
  const result = new Set(used);
  for (const [language, pattern] of Object.entries(unicodeRanges)) {
    if (result.has(language)) continue;
    if (pattern.test(text)) result.add(language);
  }
  return result;
}

function noto(fontId: string): FallbackFont {
  return {
    "font-id": fontId,
    "font-variant-id": "regular",
    style: 0,
    weight: 400,
    "is-fallback": true,
  };
}

export function addEmojiFont(fonts: readonly FallbackFont[]): FallbackFont[] {
  return [...fonts, { ...noto("gfont-noto-color-emoji"), "is-emoji": true }];
}

export const notoFonts: Record<string, FallbackFont> = {
  japanese: noto("gfont-noto-sans-jp"),
  chinese: noto("gfont-noto-sans-sc"),
  korean: noto("gfont-noto-sans-kr"),
  arabic: noto("gfont-noto-sans-arabic"),
  cyrillic: noto("gfont-noto-sans"),
  greek: noto("gfont-noto-sans"),
  hebrew: noto("gfont-noto-sans-hebrew"),
  thai: noto("gfont-noto-sans-thai"),
  devanagari: noto("gfont-noto-sans"),
  tamil: noto("gfont-noto-sans-tamil"),
  "latin-ext": noto("gfont-noto-sans"),
  vietnamese: noto("gfont-noto-sans"),
  armenian: noto("gfont-noto-sans-armenian"),
  bengali: noto("gfont-noto-sans-bengali"),
  cherokee: noto("gfont-noto-sans-cherokee"),
  ethiopic: noto("gfont-noto-sans-ethiopic"),
  georgian: noto("gfont-noto-sans-georgian"),
  gujarati: noto("gfont-noto-sans-gujarati"),
  gurmukhi: noto("gfont-noto-sans-gurmukhi"),
  khmer: noto("gfont-noto-sans-khmer"),
  lao: noto("gfont-noto-sans-lao"),
  malayalam: noto("gfont-noto-sans-malayalam"),
  myanmar: noto("gfont-noto-sans-myanmar"),
  sinhala: noto("gfont-noto-sans-sinhala"),
  telugu: noto("gfont-noto-sans-telugu"),
  tibetan: noto("gfont-noto-serif-tibetan"),
  javanese: noto("gfont-noto-sans-javanese"),
  kannada: noto("gfont-noto-sans-kannada"),
  oriya: noto("gfont-noto-sans-oriya"),
  mongolian: noto("gfont-noto-sans-mongolian"),
  syriac: noto("gfont-noto-sans-syriac"),
  tifinagh: noto("gfont-noto-sans-tifinagh"),
  coptic: noto("gfont-noto-sans-coptic"),
  "ol-chiki": noto("gfont-noto-sans-ol-chiki"),
  vai: noto("gfont-noto-sans-vai"),
  shavian: noto("gfont-noto-sans-shavian"),
  osmanya: noto("gfont-noto-sans-osmanya"),
  runic: noto("gfont-noto-sans-runic"),
  "old-italic": noto("gfont-noto-sans-old-italic"),
  brahmi: noto("gfont-noto-sans-brahmi"),
  modi: noto("gfont-noto-sans-modi"),
  "sora-sompeng": noto("gfont-noto-sans-sora-sompeng"),
  bamum: noto("gfont-noto-sans-bamum"),
  meroitic: noto("gfont-noto-sans-meroitic"),
  symbols: noto("gfont-noto-sans-symbols"),
  "symbols-2": noto("gfont-noto-sans-symbols-2"),
  music: noto("gfont-noto-music"),
};

export function addNotoFonts(
  fonts: readonly FallbackFont[],
  languages: Iterable<string>,
): FallbackFont[] {
  const out = [...fonts];
  for (const language of languages) {
    const font = notoFonts[language];
    if (font !== undefined) out.push(font);
  }
  return out;
}
