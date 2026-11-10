// The one font catalog the workspace shares (D4 task 2, the file D11 also
// reads): "which faces exist and where their bytes are", in one place so the
// text picker and the wasm font store never diverge (2026-11-10-d4 / -d11
// plans). The plan is explicit that this is the single source — no second
// built-in list.
//
// Ported from common/src/app/common/fonts.cljs:
// - local-fonts (the one family bundled with the frontend, `sourcesanspro`,
//   with its twelve weight/style variants and their TTF file names);
// - font-id->backend (the `gfont-`/`custom-` prefix rule that names the
//   source a content font-id comes from);
// - the custom half of app.main.fonts register! (the `custom-<font-id>`
//   prefix and the `<style>-<weight>` variant id the workspace texts carry),
//   fed by get-font-variants rows through lib/fonts.ts fontDisplayVariant.
//
// Kept free of the wasm module, the DOM and the store so vitest covers every
// branch. D11 (the wasm font pipeline) resolves the TTF bytes from the
// backend + ttfUrl / file ids recorded here.
//
// Deviations from the CLJS original, documented:
// - The compiled google catalog (cfnt/catalog, gfonts.2025.11.28.json, the
//   `gfont-*` families) is not folded in here: its bytes are fetched by D11's
//   pipeline, and listing them in the picker without that pipeline would show
//   names the engine cannot yet draw. buildFontsCatalog merges the built-in
//   family and the team's custom fonts now; a google-backed catalog is added
//   by D11 as a single seam (append its entries to the returned list).
// - A custom font's variant id is the `<style>-<weight>` form app.main.fonts
//   register! gives it, so a stored content font-variant-id matches without a
//   second lookup table.

import { fontDisplayVariant, type FontVariantRow } from "@/lib/fonts";

export type FontBackend = "builtin" | "google" | "custom";

export interface CatalogVariant {
  // The font-variant-id the content carries: "regular"/"bold" for the built-in
  // family, "<style>-<weight>" for a custom face.
  id: string;
  name: string;
  weight: string;
  style: string;
  // The built-in TTF file name the frontend serves from <public-uri>/fonts/
  // (cfnt local-fonts :ttf-url). Custom and google faces leave it empty:
  // their bytes come from the uploaded media asset id / gfonts proxy in D11.
  ttfUrl?: string;
  // Custom faces carry the uploaded file ids the loader and D11 read.
  woff1FileId?: string | null;
  woff2FileId?: string | null;
  ttfFileId?: string | null;
  otfFileId?: string | null;
}

export interface CatalogFont {
  // The content-level font-id: "sourcesanspro", "custom-<uuid>", "gfont-<slug>".
  id: string;
  family: string;
  // The display family name the picker shows (e.g. "Source Sans Pro").
  name: string;
  backend: FontBackend;
  variants: CatalogVariant[];
}

// cfnt/local-fonts, ported verbatim: the one bundled family and its twelve
// variants with their TTF file names. This is the source of truth for what the
// engine ships without any upload; D11 fetches these bytes for text to render.
export const BUILTIN_FONTS: readonly CatalogFont[] = [
  {
    id: "sourcesanspro",
    family: "sourcesanspro",
    name: "Source Sans Pro",
    backend: "builtin",
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

const GFONT_PREFIX = "gfont-";
const CUSTOM_PREFIX = "custom-";

// cfnt/font-id->backend: `gfont-<slug>` is google, `custom-<uuid>` is a team
// upload, everything else (the bundled family and any unknown id) resolves to
// the built-in bucket.
export function fontIdBackend(fontId: unknown): FontBackend {
  if (typeof fontId !== "string") return "builtin";
  if (fontId.startsWith(GFONT_PREFIX)) return "google";
  if (fontId.startsWith(CUSTOM_PREFIX)) return "custom";
  return "builtin";
}

// variant-sort-fn (app.main.fonts): by weight, then normal before italic. The
// three-digit weights sort lexicographically the same as numerically.
function compareVariants(a: CatalogVariant, b: CatalogVariant): number {
  if (a.weight !== b.weight) return a.weight < b.weight ? -1 : 1;
  return (a.style === "normal" ? 1 : 2) - (b.style === "normal" ? 1 : 2);
}

// Fold the team's get-font-variants rows into catalog fonts: group by font-id,
// prefix `custom-` so the id matches the content, and give each variant the
// `<style>-<weight>` id the workspace texts carry and the display name
// fontDisplayVariant derives (variant-name, else weight name plus " Italic").
export function customFontsToCatalog(rows: readonly FontVariantRow[]): CatalogFont[] {
  const grouped = new Map<string, CatalogFont>();
  for (const row of rows) {
    const id = CUSTOM_PREFIX + row["font-id"];
    let font = grouped.get(id);
    if (font === undefined) {
      font = {
        id,
        family: row["font-family"],
        name: row["font-family"],
        backend: "custom",
        variants: [],
      };
      grouped.set(id, font);
    }
    font.variants.push({
      id: `${row["font-style"]}-${row["font-weight"]}`,
      name: fontDisplayVariant(row["variant-name"], row["font-weight"], row["font-style"]),
      weight: String(row["font-weight"]),
      style: row["font-style"],
      woff1FileId: row["woff1-file-id"] ?? null,
      woff2FileId: row["woff2-file-id"] ?? null,
      ttfFileId: row["ttf-file-id"] ?? null,
      otfFileId: row["otf-file-id"] ?? null,
    });
  }
  const out: CatalogFont[] = [];
  for (const font of grouped.values()) {
    out.push({ ...font, variants: [...font.variants].sort(compareVariants) });
  }
  return out;
}

// The catalog the picker and D11 share: the built-in family plus the team's
// custom fonts, ordered so the built-in default leads. A google-backed
// catalog is appended here by D11 when its pipeline lands (the single seam).
export function buildFontsCatalog(customRows: readonly FontVariantRow[]): CatalogFont[] {
  const builtin = BUILTIN_FONTS.map((font) => ({ ...font, variants: [...font.variants] }));
  return [...builtin, ...customFontsToCatalog(customRows)];
}

// The catalog entry a content font-id names, or undefined for an id the picker
// does not know (a stale or google id before D11); the caller keeps the stored
// family name as the display value in that case.
export function findCatalogFont(catalog: readonly CatalogFont[], fontId: unknown): CatalogFont | undefined {
  if (typeof fontId !== "string") return undefined;
  return catalog.find((font) => font.id === fontId);
}

// The variant a content font-variant-id names within a font, falling back to
// the first variant when the id is stale (so the weight/style select shows a
// real option rather than a blank).
export function findCatalogVariant(font: CatalogFont, variantId: unknown): CatalogVariant | undefined {
  if (font.variants.length === 0) return undefined;
  const match = typeof variantId === "string" ? font.variants.find((v) => v.id === variantId) : undefined;
  return match ?? font.variants[0];
}
