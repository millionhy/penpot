// Fonts (F5.4). Ports the dashboard slice of app.main.data.fonts, the
// custom-font half of app.main.fonts and the shared chunked-upload helper in
// app.main.data.uploads:
//
// - upload processing: read every file once, sniff the mtype from the first
//   four bytes (octal sfnt/woff signatures, parse-mtype), parse the metadata
//   with opentype.js (woff2 cannot be parsed, so it falls back to the
//   filename), and derive family/weight/style plus the vertical-metrics
//   warning from the font tables.
// - the join that folds files of the same family/weight/style into one queue
//   item, and merge-and-group / rename-and-regroup that assign the font-id
//   the create-font-variant call will carry.
// - the CRUD and download commands, and the weight/style helpers of
//   app.common.media (parsed weights, display names).
// - the custom-font registry the @font-face CSS is generated from
//   (fonts/register! :custom and fonts/ensure-loaded!), shared by the fonts
//   page and the typography samples on the library cards.
//
// Deviations from the CLJS original, documented:
// - process-upload subscribes the blob stream twice in CLJS (an error
//   collector and the result pipeline), so every blob is read twice and the
//   bad-font toast fires while later files are still being read. The shell
//   reads each file once and returns {fonts, errors}; the page raises the
//   same bad-font / bad-font-plural toast after the fact.
// - uploads of every mtype of one item run through Promise.all (the rx/mapcat
//   merge); the chunk uploads themselves keep the two-worker pool of
//   app.main.data.uploads.
// - ensure-loaded! resolves through a per-id promise with a 120ms delay in
//   CLJS; the custom loader is synchronous, so the shell injects the style
//   and marks the id loaded in one step.
// - the font URLs go through the same-origin assets/by-id path
//   (resolveMediaUri) instead of the absolute public-URI form, so the dev
//   Next rewrites keep them working; both point at the same public bucket.
// - The worker branch of ensure-loaded! (loaded-hints) is not ported; the
//   shell has no worker fonts yet.

import { parse as parseOpenType, type OpenTypeFont } from "opentype.js";
import { config } from "@/lib/config";
import { resolveMediaUri } from "@/lib/dashboard";
import { cmd } from "@/lib/rpc";
import type { RpcParams } from "@/lib/types";
import { uploadBlobChunked } from "@/lib/uploads";

// --- Upload processing (app.main.data.fonts) --------------------------------

// font-upload-chunk-size: 10 MiB per chunk when uploading font files.
const FONT_UPLOAD_CHUNK_SIZE = 1024 * 1024 * 10;

export type FontMtype = "font/otf" | "font/ttf" | "font/woff" | "font/woff2";

// The weights the backend accepts (valid-weight in the fonts command).
export type FontWeight = 100 | 200 | 300 | 400 | 500 | 600 | 700 | 800 | 900 | 950;

export type FontStyle = "normal" | "italic";

// A raw get-font-variants row (team-font-variant table). This is the shape the
// CLJS store keeps under :fonts; the "custom-" prefix is applied when the
// fonts are registered, not here.
export interface FontVariantRow {
  id: string;
  "team-id": string;
  "font-id": string;
  "font-family": string;
  "font-weight": FontWeight;
  "font-style": FontStyle;
  "variant-name"?: string | null;
  "woff1-file-id"?: string | null;
  "woff2-file-id"?: string | null;
  "ttf-file-id"?: string | null;
  "otf-file-id"?: string | null;
}

// One entry of the uploaded-fonts queue: a file ready to be uploaded, plus
// the local editing state the table row shows (:font-family-tmp). data maps
// each sniffed mtype to the raw bytes of one file; files that share family,
// weight and style merge into a single item (join). The byte arrays are
// pinned to Uint8Array<ArrayBuffer> so they can go straight into a Blob.
export interface FontUploadItem {
  id: string;
  "team-id": string;
  "font-family": string;
  "font-family-tmp"?: string;
  "font-weight": FontWeight;
  "font-style": FontStyle;
  "variant-name"?: string;
  "height-warning"?: boolean;
  "font-id"?: string;
  names: Set<string>;
  data: Map<FontMtype, Uint8Array<ArrayBuffer>>;
}

// The intermediate shape joinUploadedFonts consumes: one blob, prepared.
export interface PreparedFont {
  content: { data: Uint8Array<ArrayBuffer>; name: string; type: FontMtype };
  "font-family": string;
  "font-weight": FontWeight;
  "font-style": FontStyle;
  "variant-name"?: string;
  "height-warning"?: boolean;
}

// parse-mtype: the first four bytes as octal numbers joined by spaces — the
// octal spelling of the sfnt/woff signatures ("OTTO" 0x4F54544F, 0x00010000,
// "wOFF", "wOF2"). An unknown signature yields undefined and the file is
// dropped silently, like the rx/mapcat in read-blob.
export function parseFontMtype(data: ArrayBuffer): FontMtype | undefined {
  const u8 = new Uint8Array(data, 0, 4);
  let signature = "";
  for (let i = 0; i < u8.length; i++) {
    signature += (i === 0 ? "" : " ") + u8[i].toString(8);
  }
  switch (signature) {
    case "117 124 124 117":
      return "font/otf";
    case "0 1 0 0":
      return "font/ttf";
    case "167 117 106 106":
      return "font/woff";
    case "167 117 106 62":
      return "font/woff2";
    default:
      return undefined;
  }
}

// The weight/style tokens familyFromFilename strips, in the order of the CLJS
// regex: extra/ultra black and bold must win over black and bold, semi/demi
// bold over bold; \s* lets "extra bold" and "extrabold" both match.
const FALLBACK_FAMILY_TOKENS = [
  "extra\\s*black",
  "ultra\\s*black",
  "extra\\s*bold",
  "ultra\\s*bold",
  "semi\\s*bold",
  "demi\\s*bold",
  "extra\\s*light",
  "ultra\\s*light",
  "hairline",
  "thin",
  "light",
  "normal",
  "regular",
  "medium",
  "bold",
  "black",
  "heavy",
  "solid",
  "italic",
].join("|");

// (?i) is the i flag; replace is global in clojure.string/replace. The token
// only matches between separators (or the string ends), so "Boldini" and
// "RobotoBold" survive. A matched token swallows the trailing separator, so
// in "Roboto Bold Italic" the "Italic" directly after it cannot match — the
// same quirk the CLJS regex has.
const fallbackFamilyRe = new RegExp(
  "(^|[-_\\s])(" + FALLBACK_FAMILY_TOKENS + ")([-_\\s]|$)",
  "gi",
);

// familyFromFilename, the woff2 fallback branch of prepare: strip the
// extension, drop the weight/style tokens that sit on word boundaries and
// collapse the separators. A name that reduces to blank falls back to the
// base name, so "regular.ttf" stays "regular".
export function familyFromFilename(name: string): string {
  const baseName = name.replace(/\.[^.]+$/, "");
  const rawFamilyName = baseName
    .replace(fallbackFamilyRe, "$1$3")
    .replace(/[-_\s]+/g, " ")
    .trim();
  return rawFamilyName === "" ? baseName : rawFamilyName;
}

// parse-font-weight: the lookahead treats "BoldItalic" as a boundary too, and
// the order matters — extra/ultra light before light, semi/demi bold and
// extra/ultra bold before bold, extra/ultra black before black.
const FONT_WEIGHT_PATTERNS: ReadonlyArray<readonly [FontWeight, RegExp]> = [
  [100, /(?:^|[-_\s])(?:hairline|thin)(?=(?:[-_\s]|$|italic\b))/i],
  [200, /(?:^|[-_\s])(?:extra\s*light|ultra\s*light)(?=(?:[-_\s]|$|italic\b))/i],
  [300, /(?:^|[-_\s])(?:light)(?=(?:[-_\s]|$|italic\b))/i],
  [400, /(?:^|[-_\s])(?:normal|regular)(?=(?:[-_\s]|$|italic\b))/i],
  [500, /(?:^|[-_\s])(?:medium)(?=(?:[-_\s]|$|italic\b))/i],
  [600, /(?:^|[-_\s])(?:semi\s*bold|demi\s*bold)(?=(?:[-_\s]|$|italic\b))/i],
  [800, /(?:^|[-_\s])(?:extra\s*bold|ultra\s*bold)(?=(?:[-_\s]|$|italic\b))/i],
  [700, /(?:^|[-_\s])(?:bold)(?=(?:[-_\s]|$|italic\b))/i],
  [950, /(?:^|[-_\s])(?:extra\s*black|ultra\s*black)(?=(?:[-_\s]|$|italic\b))/i],
  [900, /(?:^|[-_\s])(?:black|heavy|solid)(?=(?:[-_\s]|$|italic\b))/i],
];

export function parseFontWeight(variant: string): FontWeight {
  for (const [weight, pattern] of FONT_WEIGHT_PATTERNS) {
    if (pattern.test(variant)) return weight;
  }
  return 400;
}

// parse-font-style: "Italic" on a word boundary or at the end of the name;
// "Oblique" does not count.
export function parseFontStyle(variant: string): FontStyle {
  if (/(?:^|[-_\s])italic(?:[-_\s]|$)/i.test(variant) || /italic$/i.test(variant)) {
    return "italic";
  }
  return "normal";
}

const FONT_WEIGHT_NAMES: Record<FontWeight, string> = {
  100: "Hairline",
  200: "Extra Light",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "Semi Bold",
  700: "Bold",
  800: "Extra Bold",
  900: "Black",
  950: "Extra Black",
};

// font-weight->name: only the weights the backend accepts have a name.
export function fontWeightName(weight: FontWeight): string {
  const name = FONT_WEIGHT_NAMES[weight];
  if (name === undefined) {
    throw new Error(`no display name for font weight ${weight}`);
  }
  return name;
}

// font-display-variant: the name the font carries wins when it is a non-blank
// string; otherwise the weight name, plus " Italic" for an italic variant.
export function fontDisplayVariant(
  variantName: string | null | undefined,
  weight: FontWeight,
  style: FontStyle | string,
): string {
  if (typeof variantName === "string" && variantName.trim() !== "") {
    return variantName.trim();
  }
  const base = fontWeightName(weight);
  return style === "italic" ? base + " Italic" : base;
}

// schema:font-family (app.common.types.font): non-blank text, at most 250
// chars, letters/digits/space/_-./ (Unicode letters included). Callers raise
// errors.font-family-invalid-chars when this fails.
export function validFontFamily(value: string): boolean {
  if (value.trim() === "" || value.length > 250) return false;
  return /^[\p{L}\d _.-]+$/u.test(value);
}

// uuid/next stand-in. crypto.randomUUID exists in every browser Next 15
// targets and in the Node test runner.
function defaultNewId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "fnt-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface ProcessUploadOptions {
  // Test seams.
  parse?: (data: ArrayBuffer) => OpenTypeFont;
  readBlob?: (file: File) => Promise<ArrayBuffer>;
  newId?: () => string;
}

// prepare (the opentype branch): family and variant come from the preferred
// english names, falling back to the legacy ones; the vertical-metrics
// warning compares the hhea, usWin and — only when useTypoMetrics (bit 7 of
// fsSelection) is set — the OS/2 pairs. A missing table yields NaN, which is
// never equal to another NaN, the same result the CLJS abs/not= chain gives.
function prepareFromFont(
  font: OpenTypeFont,
  name: string,
  data: ArrayBuffer,
  type: FontMtype,
): PreparedFont {
  const family = font.getEnglishName("preferredFamily") || font.getEnglishName("fontFamily");
  const variant =
    font.getEnglishName("preferredSubfamily") || font.getEnglishName("fontSubfamily");

  const hheaAscender = Math.abs(font.tables.hhea?.ascender ?? NaN);
  const hheaDescender = Math.abs(font.tables.hhea?.descender ?? NaN);
  const winAscent = Math.abs(font.tables.os2?.usWinAscent ?? NaN);
  const winDescent = Math.abs(font.tables.os2?.usWinDescent ?? NaN);
  const os2Ascent = Math.abs(font.tables.os2?.sTypoAscender ?? NaN);
  const os2Descent = Math.abs(font.tables.os2?.sTypoDescender ?? NaN);
  const useTypoMetrics = ((font.tables.os2?.fsSelection ?? 0) & 128) !== 0;

  const heightWarning =
    hheaAscender !== winAscent ||
    hheaDescender !== winDescent ||
    (useTypoMetrics && (hheaAscender !== os2Ascent || hheaDescender !== os2Descent));

  return {
    content: { data: new Uint8Array(data), name, type },
    "font-family": family ?? "",
    "font-weight": parseFontWeight(variant ?? ""),
    "font-style": parseFontStyle(variant ?? ""),
    "variant-name": variant,
    "height-warning": heightWarning,
  };
}

// prepare (the woff2 fallback branch): opentype.js cannot parse woff2, so the
// metadata comes from the filename. This branch has no variant name at all,
// so the display name falls back to the weight/style form.
function prepareFromFilename(name: string, data: ArrayBuffer, type: FontMtype): PreparedFont {
  const baseName = name.replace(/\.[^.]+$/, "");
  return {
    content: { data: new Uint8Array(data), name, type },
    "font-family": familyFromFilename(name),
    "font-weight": parseFontWeight(baseName),
    "font-style": parseFontStyle(baseName),
    "height-warning": false,
  };
}

// process-upload: read every file once (see the deviation note on top),
// sniff the mtype, parse the metadata and join the entries into queue items.
// The errors array holds the quoted names the page joins for the bad-font /
// bad-font-plural toast.
export async function processUpload(
  files: File[],
  teamId: string,
  options: ProcessUploadOptions = {},
): Promise<{ fonts: Map<string, FontUploadItem>; errors: string[] }> {
  const parse = options.parse ?? parseOpenType;
  const readBlob = options.readBlob ?? ((file: File) => file.arrayBuffer());
  const newId = options.newId ?? defaultNewId;

  const errors: string[] = [];
  const prepared: PreparedFont[] = [];

  for (const file of files) {
    let data: ArrayBuffer;
    try {
      data = await readBlob(file);
    } catch {
      errors.push(`'${file.name}'`);
      continue;
    }

    const type = parseFontMtype(data);
    if (type === undefined) continue;

    if (type === "font/woff2") {
      prepared.push(prepareFromFilename(file.name, data, type));
      continue;
    }

    let font: OpenTypeFont;
    try {
      font = parse(data);
    } catch {
      // parse-font logs and drops unparsable files (no error notification).
      continue;
    }
    prepared.push(prepareFromFont(font, file.name, data, type));
  }

  return { fonts: joinUploadedFonts(prepared, teamId, newId), errors };
}

// join: entries of the same family, weight and style fold into one queue item
// — their bytes keyed by mtype, their names collected. The temporary id is
// what the table row carries until merge-and-group assigns the font-id.
export function joinUploadedFonts(
  fonts: PreparedFont[],
  teamId: string,
  newId: () => string = defaultNewId,
): Map<string, FontUploadItem> {
  const keyOf = (item: {
    "font-family": string;
    "font-weight": FontWeight;
    "font-style": FontStyle;
  }) => JSON.stringify([item["font-family"], item["font-weight"], item["font-style"]]);

  const result = new Map<string, FontUploadItem>();
  for (const font of fonts) {
    let existing: FontUploadItem | undefined;
    for (const item of result.values()) {
      if (keyOf(item) === keyOf(font)) {
        existing = item;
        break;
      }
    }
    if (existing !== undefined) {
      existing.data.set(font.content.type, font.content.data);
      existing.names.add(font.content.name);
    } else {
      const id = newId();
      result.set(id, {
        id,
        "team-id": teamId,
        "font-family": font["font-family"],
        "font-weight": font["font-weight"],
        "font-style": font["font-style"],
        "variant-name": font["variant-name"],
        "height-warning": font["height-warning"],
        names: new Set([font.content.name]),
        data: new Map([[font.content.type, font.content.data]]),
      });
    }
  }
  return result;
}

// calculate-family-to-id-mapping: family -> font-id. The installed fonts win,
// because a queue item merged earlier already carries the id its family was
// installed under.
function calculateFamilyToIdMapping(
  currentFonts: Map<string, FontUploadItem>,
  installedFonts: FontVariantRow[],
): Map<string, string> {
  const famdb = new Map<string, string>();
  for (const item of currentFonts.values()) {
    if (item["font-id"] !== undefined) famdb.set(item["font-family"], item["font-id"]);
  }
  for (const row of installedFonts) {
    famdb.set(row["font-family"], row["font-id"]);
  }
  return famdb;
}

// merge-and-group-fonts: fold the processed queue (incoming) into the local
// one, reusing the font-id installed families already have and minting ids
// for new families, so every file of a family uploads under one id.
export function mergeAndGroupFonts(
  currentFonts: Map<string, FontUploadItem>,
  installedFonts: FontVariantRow[],
  incomingFonts: Map<string, FontUploadItem>,
  newId: () => string = defaultNewId,
): Map<string, FontUploadItem> {
  const famdb = calculateFamilyToIdMapping(currentFonts, installedFonts);
  const result = new Map(currentFonts);
  for (const item of incomingFonts.values()) {
    const family = item["font-family"];
    const fontId = famdb.get(family) ?? newId();
    famdb.set(family, fontId);
    result.set(item.id, { ...item, "font-id": fontId });
  }
  return result;
}

// rename-and-regroup: a family edit in the queue keeps the font-id of an
// existing family of that name, or mints a new one.
export function renameAndRegroup(
  currentFonts: Map<string, FontUploadItem>,
  id: string,
  name: string,
  installedFonts: FontVariantRow[],
  newId: () => string = defaultNewId,
): Map<string, FontUploadItem> {
  const fontId = calculateFamilyToIdMapping(currentFonts, installedFonts).get(name) ?? newId();
  const result = new Map(currentFonts);
  const item = result.get(id);
  if (item !== undefined) {
    result.set(id, { ...item, "font-family": name, "font-id": fontId });
  }
  return result;
}

// upload-font-variant: upload every mtype of the item as its own chunked
// session (in parallel, like the rx/mapcat) and create the font variant from
// the mtype -> session-id map, returning the created row.
export async function uploadFontVariant(item: FontUploadItem): Promise<FontVariantRow> {
  const fontId = item["font-id"];
  if (fontId === undefined) {
    throw new Error("font-id is assigned by merge-and-group-fonts");
  }

  const sessions = await Promise.all(
    [...item.data.entries()].map(async ([mtype, bytes]) => {
      const blob = new Blob([bytes], { type: mtype });
      const { sessionId } = await uploadBlobChunked(blob, { chunkSize: FONT_UPLOAD_CHUNK_SIZE });
      return [mtype, sessionId] as const;
    }),
  );
  const uploads: Record<string, string> = {};
  for (const [mtype, sessionId] of sessions) uploads[mtype] = sessionId;

  const params: RpcParams["create-font-variant"] = {
    "team-id": item["team-id"],
    "font-id": fontId,
    "font-family": item["font-family"],
    "font-weight": item["font-weight"],
    "font-style": item["font-style"],
    uploads,
  };
  return cmd<FontVariantRow>("create-font-variant", params);
}

// --- Dashboard commands (app.main.data.fonts) -------------------------------

export function getFontVariants(teamId: string): Promise<FontVariantRow[]> {
  const params: RpcParams["get-font-variants"] = { "team-id": teamId };
  return cmd<FontVariantRow[]>("get-font-variants", params);
}

export function updateFont(params: RpcParams["update-font"]): Promise<unknown> {
  return cmd("update-font", params);
}

export function deleteFont(teamId: string, fontId: string): Promise<unknown> {
  const params: RpcParams["delete-font"] = { "team-id": teamId, id: fontId };
  return cmd("delete-font", params);
}

export function deleteFontVariant(teamId: string, id: string): Promise<unknown> {
  const params: RpcParams["delete-font-variant"] = { "team-id": teamId, id };
  return cmd("delete-font-variant", params);
}

// download-font / download-font-family answer {id uri name}; the caller
// fetches the uri and hands the blob to trigger-download.
export interface FontDownloadInfo {
  id: string;
  uri: string;
  name: string;
}

export function downloadFont(id: string): Promise<FontDownloadInfo> {
  const params: RpcParams["download-font"] = { id };
  return cmd<FontDownloadInfo>("download-font", params);
}

export function downloadFontFamily(fontId: string): Promise<FontDownloadInfo> {
  const params: RpcParams["download-font-family"] = { "font-id": fontId };
  return cmd<FontDownloadInfo>("download-font-family", params);
}

// --- Custom font registry (the :custom half of app.main.fonts) --------------

// prepare-font-variant (fonts-fetched): id "<style>-<weight>", display name
// from variant-name/weight/style, and the file ids the loader picks the woff1
// url from.
export interface CustomFontVariant {
  id: string;
  name: string;
  style: string;
  weight: string;
  woff1FileId?: string | null;
  woff2FileId?: string | null;
  ttfFileId?: string | null;
  otfFileId?: string | null;
}

export interface CustomFontRecord {
  id: string;
  name: string;
  family: string;
  variants: CustomFontVariant[];
}

const customFontRegistry = new Map<string, CustomFontRecord>();
const loadedFontIds = new Set<string>();

// variant-sort-fn: by weight, then normal before italic. The weights are the
// string forms, whose lexicographic order matches the numeric one for every
// valid (three digit) weight — the same sort CLJS does.
function variantSortCompare(a: CustomFontVariant, b: CustomFontVariant): number {
  if (a.weight !== b.weight) return a.weight < b.weight ? -1 : 1;
  return (a.style === "normal" ? 1 : 2) - (b.style === "normal" ? 1 : 2);
}

// register! :custom (the effect of fonts-fetched): adapt the ids to the
// "custom-" prefix the workspace texts carry, group the rows by font id and
// prepare the variants. The CLJS register! replaces only the entries of the
// :custom backend, which is the only backend the shell registers so far.
export function registerCustomFonts(rows: FontVariantRow[]): void {
  customFontRegistry.clear();
  const grouped = new Map<string, FontVariantRow[]>();
  for (const row of rows) {
    const fontId = "custom-" + row["font-id"];
    const list = grouped.get(fontId);
    if (list === undefined) grouped.set(fontId, [row]);
    else list.push(row);
  }
  for (const [fontId, items] of grouped) {
    const variants = items
      .map(
        (row): CustomFontVariant => ({
          id: `${row["font-style"]}-${row["font-weight"]}`,
          name: fontDisplayVariant(row["variant-name"], row["font-weight"], row["font-style"]),
          style: row["font-style"],
          weight: String(row["font-weight"]),
          woff1FileId: row["woff1-file-id"],
          woff2FileId: row["woff2-file-id"],
          ttfFileId: row["ttf-file-id"],
          otfFileId: row["otf-file-id"],
        }),
      )
      .sort(variantSortCompare);
    customFontRegistry.set(fontId, {
      id: fontId,
      name: items[0]["font-family"],
      family: items[0]["font-family"],
      variants,
    });
  }
}

// font-face-template / generate-custom-font-variant-css: the CSS one variant
// loads through. The uri goes through the same-origin assets/by-id path (see
// the deviation note on top).
export function customFontFaceCss(
  family: string,
  variant: CustomFontVariant,
  publicUri: string = config.publicUri,
): string {
  const uri = resolveMediaUri(publicUri, variant.woff1FileId ?? "");
  return `@font-face {
    font-family: '${family}';
    font-style: ${variant.style};
    font-weight: ${variant.weight};
    font-display: block;
    src: url(${uri}) format('woff');
  }`;
}

export function customFontCss(
  font: CustomFontRecord,
  publicUri: string = config.publicUri,
): string {
  return font.variants
    .map((variant) => customFontFaceCss(font.family, variant, publicUri))
    .join("\n");
}

// add-font-css: one <style id=font-id> per registered font.
function addFontCss(id: string, css: string): void {
  const node = document.createElement("style");
  node.setAttribute("id", id);
  node.textContent = css;
  document.head.appendChild(node);
}

// ensure-loaded!: inject the @font-face block of a custom font once. Unknown
// ids are a no-op (the builtin/google families are not in this registry), and
// so is a headless call, so callers can invoke it blindly.
export function ensureLoaded(fontId: string): void {
  const font = customFontRegistry.get(fontId);
  if (font === undefined || loadedFontIds.has(fontId)) return;
  if (typeof document === "undefined") return;
  addFontCss(fontId, customFontCss(font));
  loadedFontIds.add(fontId);
}

// Test seam: read the registry back without going through the DOM.
export function lookupCustomFont(fontId: string): CustomFontRecord | undefined {
  return customFontRegistry.get(fontId);
}
