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
