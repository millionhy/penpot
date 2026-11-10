// The font resolution half of the wasm text pipeline (D11). Pure data + pure
// fns — no wasm module, no DOM — so vitest exercises every branch and the
// engine-facing store step (lib/render-wasm/fonts-store.ts) only feeds these
// results to the wasm exports.
//
// Ported from:
// - common/src/app/common/fonts.cljs (font-id->backend, font-id->uuid,
//   closest-variant, local-fonts / resolve-ttf-file, gstatic->proxy-url);
// - frontend/src/app/render_wasm/api/fonts.cljs (make-font-data: the
//   weight/style/asset-id resolution the store call consumes,
//   serialize-font-weight / serialize-font-style, font-id->ttf-url);
// - frontend/src/app/main/fonts.cljs (get-variant, find-closest-variant ->
//   cfnt/closest-variant, get-default-variant).
//
// What store_font keys on: the FAMILY uuid (font-id->uuid, NOT the shape id)
// plus an integer weight and an integer style (0 normal / 1 italic) — see
// render-wasm/src/wasm/fonts.rs. Builtin faces all share the zero uuid and are
// told apart by weight+style, like the CLJS.
//
// Deviations from the CLJS original, documented:
// - First milestone resolves builtin (complete) and custom (from the injected
//   team registry) faces. Google faces are recognised but answered as
//   unsupported (status "google-unsupported") so the caller falls back: the
//   google catalog is a 47k-line JSON (gfonts.2025.11.28.json) deliberately
//   kept out of this slice, and the parity file's default is the builtin
//   `sourcesanspro`. Re-add google resolution by loading that catalog when a
//   follow-on needs it.
// - Only the serializers the store path needs are ported (weight, style,
//   variant normalisation). The layout serializers (font-size, line-height,
//   letter-spacing) are not used here because the wasm text layout reads them
//   off the shape record already pushed through set_object.

import { uuidToU32 } from "@/lib/render-wasm/interop";

export type U32Quartet = readonly [number, number, number, number];

export type FontBackend = "google" | "custom" | "builtin";

export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// One builtin variant: the fields of cfnt/local-fonts entries the resolution
// reads (weight is a numeric string, style "normal"|"italic").
export interface BuiltinVariant {
  readonly id: string;
  readonly name: string;
  readonly weight: string;
  readonly style: string;
  readonly ttfUrl: string;
}

// cfnt/local-fonts: the single family bundled with the frontend. It is the
// default text font ("sourcesanspro" resolves to uuid/zero) and the font the
// parity file uses, so this slice ships its full variant table verbatim.
export const BUILTIN_FONTS: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly family: string;
  readonly variants: readonly BuiltinVariant[];
}> = [
  {
    id: "sourcesanspro",
    name: "Source Sans Pro",
    family: "sourcesanspro",
    variants: [
      { id: "200", name: "200", weight: "200", style: "normal", ttfUrl: "sourcesanspro-extralight.ttf" },
      { id: "200italic", name: "200 Italic", weight: "200", style: "italic", ttfUrl: "sourcesanspro-extralightitalic.ttf" },
      { id: "300", name: "300", weight: "300", style: "normal", ttfUrl: "sourcesanspro-light.ttf" },
      { id: "300italic", name: "300 Italic", weight: "300", style: "italic", ttfUrl: "sourcesanspro-lightitalic.ttf" },
      { id: "regular", name: "400", weight: "400", style: "normal", ttfUrl: "sourcesanspro-regular.ttf" },
      { id: "italic", name: "400 Italic", weight: "400", style: "italic", ttfUrl: "sourcesanspro-italic.ttf" },
      { id: "600", name: "600", weight: "600", style: "normal", ttfUrl: "sourcesanspro-semibold.ttf" },
      { id: "600italic", name: "600 Italic", weight: "600", style: "italic", ttfUrl: "sourcesanspro-semibolditalic.ttf" },
      { id: "bold", name: "700", weight: "700", style: "normal", ttfUrl: "sourcesanspro-bold.ttf" },
      { id: "bolditalic", name: "700 Italic", weight: "700", style: "italic", ttfUrl: "sourcesanspro-bolditalic.ttf" },
      { id: "black", name: "900", weight: "900", style: "normal", ttfUrl: "sourcesanspro-black.ttf" },
      { id: "blackitalic", name: "900 Italic", weight: "900", style: "italic", ttfUrl: "sourcesanspro-blackitalic.ttf" },
    ],
  },
];

// A face reference extracted from a text content tree (the shape the CLJS
// get-content-fonts produces per text node).
export interface FontFaceRef {
  fontId: string;
  fontVariantId?: string;
  fontWeight?: string | number;
  fontStyle?: string;
  isEmoji?: boolean;
  isFallback?: boolean;
}

// A resolved face ready for store_font: the four uuid words of the family, the
// integer weight, the integer style, and the same-origin URL to fetch the TTF
// bytes from.
export interface ResolvedFontFace {
  readonly backend: FontBackend;
  readonly familyUuid: string;
  readonly wasmIdWords: U32Quartet;
  readonly weight: number;
  readonly style: number; // 0 normal, 1 italic
  readonly ttfUrl: string;
  readonly isEmoji: boolean;
  readonly isFallback: boolean;
}

export type ResolveOutcome =
  | { readonly ok: true; readonly face: ResolvedFontFace }
  | { readonly ok: false; readonly status: "google-unsupported" | "custom-missing-file" | "unknown-builtin" };

// --- font-id -> backend / uuid (cfnt) ---------------------------------------

const CUSTOM_PREFIX = "custom-";
const GFONT_PREFIX = "gfont-";

// cfnt/font-id->backend: a non-string or anything not gfont-/custom- is the
// builtin bucket.
export function fontIdToBackend(fontId: string | undefined | null): FontBackend {
  if (typeof fontId !== "string") return "builtin";
  if (fontId.startsWith(GFONT_PREFIX)) return "google";
  if (fontId.startsWith(CUSTOM_PREFIX)) return "custom";
  return "builtin";
}

// A loose uuid-shaped check for the custom-<uuid> suffix, so a malformed id
// falls back to uuid/zero like cfnt's (uuid/parse* ... uuid/zero).
const UUID_FORM =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// cfnt/font-id->uuid. Google needs the catalog uuid (unsupported in this
// slice -> zero, matching cfnt's `(or ... uuid/zero)`); custom parses the
// suffix; builtin is always uuid/zero.
export function fontIdToUuid(fontId: string | undefined | null): string {
  switch (fontIdToBackend(fontId)) {
    case "google":
      return ZERO_UUID;
    case "custom": {
      const suffix = (fontId as string).slice(CUSTOM_PREFIX.length);
      return UUID_FORM.test(suffix) ? suffix.toLowerCase() : ZERO_UUID;
    }
    default:
      return ZERO_UUID;
  }
}

// --- serializers (fonts.cljs make-font-data) --------------------------------

// render_wasm.api.fonts/serialize-font-style.
export function serializeFontStyle(fontStyle: string | undefined | null): number {
  switch (fontStyle) {
    case "normal":
    case "regular":
      return 0;
    case "italic":
      return 1;
    default:
      return 0;
  }
}

// render_wasm.api.fonts/serialize-font-weight: numeric pass-through, else the
// weight-name table, defaulting to 400.
// The branch order is the CLJS `cond` order verbatim: "bold" is tested before
// "semibold"/"extrabold", so those two substrings resolve to 700 (they contain
// "bold"). Keep this order — "correcting" it would diverge from the original.
export function serializeFontWeight(fontWeight: string | number | undefined | null): number {
  if (typeof fontWeight === "number") return fontWeight;
  const value = fontWeight === undefined || fontWeight === null ? "" : String(fontWeight);
  if (/^\d+$/.test(value)) return Number.parseInt(value, 10);
  if (value.includes("bold")) return 700;
  if (value.includes("black")) return 900;
  if (value.includes("extrabold")) return 800;
  if (value.includes("extralight")) return 200;
  if (value.includes("light")) return 300;
  if (value.includes("medium")) return 500;
  if (value.includes("semibold")) return 600;
  if (value.includes("thin")) return 100;
  return 400;
}

// cfnt variant-id normalisation + the make-font-data lower/strip of
// font-variant-id (str/lower, drop whitespace).
export function normalizeVariantId(fontVariantId: string | undefined | null): string {
  if (fontVariantId === undefined || fontVariantId === null) return "";
  return fontVariantId.toLowerCase().replace(/\s+/g, "");
}

// --- variant resolution (cfnt/closest-variant, fonts.cljs font-db-data) -----

const UNSAFE_INTEGER = Number.MAX_SAFE_INTEGER;

// d/parse-integer, the way closest-variant uses it: nil/NaN-safe integer parse.
function parseInteger(value: string | number | undefined | null): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

interface VariantLike {
  readonly weight: string;
  readonly style: string;
}

// cfnt/closest-variant, ported faithfully: nearest integer weight (exact weight
// + style wins immediately; ties break toward the higher weight, then toward the
// style match). `variants` is non-empty or this returns null.
export function closestVariant<T extends VariantLike>(
  variants: readonly T[],
  targetWeight: string | number | undefined | null,
  targetStyle: string | undefined | null,
): T | null {
  const parsedTarget = parseInteger(targetWeight);
  if (parsedTarget === null) return null;

  let closest: { variant: T; weight: number; distance: number } | null = null;

  for (const variant of variants) {
    const weight = parseInteger(variant.weight) ?? UNSAFE_INTEGER;
    const distance = Math.abs(parsedTarget - weight);
    const matchesStyle = targetStyle === undefined || targetStyle === null
      ? true
      : variant.style === targetStyle;

    if (distance === 0 && matchesStyle) {
      return variant; // exact match found
    }

    if (closest === null) {
      closest = { variant, weight, distance };
      continue;
    }

    const closer =
      distance < closest.distance ||
      (distance === closest.distance && weight > closest.weight);
    if (closer) {
      closest = { variant, weight, distance };
      continue;
    }

    if (weight === closest.weight && matchesStyle) {
      closest = { variant, weight, distance };
    }
  }

  return closest ? closest.variant : null;
}

// app.main.fonts/get-default-variant + get-variant for a builtin font: match the
// id, else the "regular"/"name === regular" default, else the first variant.
function getBuiltinVariant(variants: readonly BuiltinVariant[], variantId: string): BuiltinVariant | undefined {
  const byId = variants.find((variant) => variant.id === variantId);
  if (byId) return byId;
  const regular = variants.find((variant) => variant.id === "regular" || variant.name === "regular");
  return regular ?? variants[0];
}

// fonts.cljs/font-db-data for a builtin font: prefer the explicit variant-id
// unless weight/style indicate a nearer variant than the id one.
function builtinFontData(variants: readonly BuiltinVariant[], variantId: string, weight: string | number | undefined, style: string | undefined): BuiltinVariant | undefined {
  const variant = getBuiltinVariant(variants, variantId);
  const closest = closestVariant(variants, weight, style);
  if (closest === null || (variant !== undefined && closest.ttfUrl === variant.ttfUrl)) {
    return variant;
  }
  return closest;
}

// --- URL building (cfnt.gstatic->proxy-url / fonts.cljs font-id->ttf-url) ----

function joinBase(publicUri: string): string {
  return publicUri.endsWith("/") ? publicUri : publicUri + "/";
}

// builtin: <public-uri>fonts/<ttf-url> (the CLJS :builtin branch). Relative when
// publicUri is "" (dev, proxied by the /fonts rewrite D11 adds).
export function builtinTtfUrl(ttfFileName: string, publicUri = ""): string {
  return joinBase(publicUri) + "fonts/" + ttfFileName;
}

// custom: <public-uri>assets/by-id/<ttf-file-id> (cf/resolve-media; the same
// path lib/fonts.ts uses for the DOM @font-face).
export function customTtfUrl(ttfFileId: string, publicUri = ""): string {
  return joinBase(publicUri) + "assets/by-id/" + ttfFileId;
}

// --- resolution dispatcher --------------------------------------------------

// A custom-team font variant the caller resolved from lib/fonts.ts
// (getFontVariants rows). weight/style match the stored face; only a `ttf-file-id`
// can be fed to store_font (the CLJS "only TTF fonts can be stored").
export interface CustomVariant {
  readonly weight: string | number;
  readonly style: string;
  readonly ttfFileId?: string | null;
}

export interface ResolveContext {
  readonly publicUri?: string;
  // For a custom face: the variant row matching this font-id + weight/style.
  readonly customVariant?: CustomVariant;
}

// make-font-data + font-id->ttf-url for one reference. Returns a
// ResolvedFontFace for builtin/custom, or a status for the unsupported /
// missing-data branches so the caller can fall back instead of hanging layout.
export function resolveFontFace(ref: FontFaceRef, ctx: ResolveContext = {}): ResolveOutcome {
  const backend = fontIdToBackend(ref.fontId);
  const publicUri = ctx.publicUri ?? "";
  const isEmoji = ref.isEmoji ?? false;
  const isFallback = ref.isFallback ?? false;

  if (backend === "google") {
    return { ok: false, status: "google-unsupported" };
  }

  if (backend === "custom") {
    const custom = ctx.customVariant;
    if (custom === undefined || custom.ttfFileId === undefined || custom.ttfFileId === null) {
      return { ok: false, status: "custom-missing-file" };
    }
    const familyUuid = fontIdToUuid(ref.fontId);
    return {
      ok: true,
      face: {
        backend,
        familyUuid,
        wasmIdWords: uuidToU32(familyUuid),
        weight: serializeFontWeight(custom.weight),
        style: serializeFontStyle(custom.style),
        ttfUrl: customTtfUrl(custom.ttfFileId, publicUri),
        isEmoji,
        isFallback,
      },
    };
  }

  // builtin: everything that is not gfont-/custom- (also unknown ids), resolved
  // against the sourcesanspro table like the CLJS uuid->font-id default.
  const family = BUILTIN_FONTS[0];
  const variantId = normalizeVariantId(ref.fontVariantId) || "regular";
  const variant = builtinFontData(family.variants, variantId, ref.fontWeight, ref.fontStyle);
  if (variant === undefined) {
    return { ok: false, status: "unknown-builtin" };
  }
  const rawWeight = variant.weight ?? ref.fontWeight ?? 400;
  const styleName = variantId.includes("italic") || String(rawWeight).includes("italic")
    ? "italic"
    : (ref.fontStyle ?? "normal");
  return {
    ok: true,
    face: {
      backend,
      familyUuid: ZERO_UUID,
      wasmIdWords: uuidToU32(ZERO_UUID),
      weight: serializeFontWeight(rawWeight),
      style: serializeFontStyle(styleName),
      ttfUrl: builtinTtfUrl(variant.ttfUrl, publicUri),
      isEmoji,
      isFallback,
    },
  };
}

// --- content -> font references (fonts.cljs get-content-fonts) --------------

// app.common.types.text/default-typography, the fallbacks get-content-fonts
// applies to a node missing a font attr. They match lib/workspace-text.ts
// TEXT_DEFAULT_ATTRS; inlined so this module stays free of the model layer.
const DEFAULT_FONT_ID = "sourcesanspro";
const DEFAULT_FONT_VARIANT = "regular";
const DEFAULT_FONT_WEIGHT = "400";
const DEFAULT_FONT_STYLE = "normal";

// A stable key for one face reference: the four fields make-font-data reads.
// Callers dedupe text nodes down to the distinct faces they must fetch.
export function fontFaceKey(ref: FontFaceRef): string {
  return [
    ref.fontId,
    ref.fontVariantId ?? "",
    String(ref.fontWeight ?? ""),
    ref.fontStyle ?? "",
    ref.isEmoji ? "1" : "0",
    ref.isFallback ? "1" : "0",
  ].join("\u0000");
}

// fonts.cljs/get-content-fonts: walk the draft-js content tree
// (root -> paragraph-set -> paragraph -> text node) and collect the distinct
// faces its text spans use, falling back to the default typography per field.
// `content` is the JS-side shape content (kebab-case keys); anything that is
// not the expected nested array shape is skipped rather than throwing.
export function getContentFonts(content: unknown): FontFaceRef[] {
  if (content === null || typeof content !== "object") return [];
  const roots = (content as { children?: unknown }).children;
  if (!Array.isArray(roots)) return [];

  const byKey = new Map<string, FontFaceRef>();
  for (const paragraphSet of roots) {
    const paragraphs = asChildren(paragraphSet);
    if (paragraphs === null) continue;
    for (const paragraph of paragraphs) {
      const nodes = asChildren(paragraph);
      if (nodes === null) continue;
      for (const node of nodes) {
        if (node === null || typeof node !== "object") continue;
        const record = node as Record<string, unknown>;
        // A text node carries a string `text`; other inline nodes are skipped.
        if (typeof record.text !== "string") continue;
        const ref: FontFaceRef = {
          fontId: strOr(record["font-id"], DEFAULT_FONT_ID),
          fontVariantId: strOr(record["font-variant-id"], DEFAULT_FONT_VARIANT),
          fontWeight: strOr(record["font-weight"], DEFAULT_FONT_WEIGHT),
          fontStyle: strOr(record["font-style"], DEFAULT_FONT_STYLE),
          isEmoji: record["is-emoji"] === true,
          isFallback: record["is-fallback"] === true,
        };
        const key = fontFaceKey(ref);
        if (!byKey.has(key)) byKey.set(key, ref);
      }
    }
  }
  return Array.from(byKey.values());
}

function asChildren(node: unknown): readonly unknown[] | null {
  if (node === null || typeof node !== "object") return null;
  const children = (node as { children?: unknown }).children;
  return Array.isArray(children) ? children : null;
}

function strOr(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
