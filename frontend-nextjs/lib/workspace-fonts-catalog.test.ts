// Unit tests for the shared font catalog (lib/workspace-fonts-catalog): the
// ported built-in family, the backend prefix rule, the custom get-font-variants
// grouping (id, variant id, display name, sort) and the picker lookups. All
// pure: no wasm, no DOM, no store.

import { describe, expect, it } from "vitest";

import type { FontVariantRow } from "@/lib/fonts";
import {
  BUILTIN_FONTS,
  buildFontsCatalog,
  customFontsToCatalog,
  findCatalogFont,
  findCatalogVariant,
  fontIdBackend,
} from "@/lib/workspace-fonts-catalog";

function row(overrides: Partial<FontVariantRow>): FontVariantRow {
  return {
    id: overrides.id ?? "row-1",
    "team-id": overrides["team-id"] ?? "team-1",
    "font-id": overrides["font-id"] ?? "abc",
    "font-family": overrides["font-family"] ?? "Inter",
    "font-weight": overrides["font-weight"] ?? 400,
    "font-style": overrides["font-style"] ?? "normal",
    "variant-name": overrides["variant-name"] ?? null,
  };
}

describe("BUILTIN_FONTS", () => {
  it("carries the one bundled sourcesanspro family", () => {
    expect(BUILTIN_FONTS).toHaveLength(1);
    const font = BUILTIN_FONTS[0];
    expect(font.id).toBe("sourcesanspro");
    expect(font.family).toBe("sourcesanspro");
    expect(font.name).toBe("Source Sans Pro");
    expect(font.backend).toBe("builtin");
  });

  it("ports the twelve variants and the regular default", () => {
    const variants = BUILTIN_FONTS[0].variants;
    expect(variants).toHaveLength(12);
    const regular = variants.find((v) => v.id === "regular");
    expect(regular).toMatchObject({ weight: "400", style: "normal", ttfUrl: "sourcesanspro-regular.ttf" });
    const bold = variants.find((v) => v.id === "bold");
    expect(bold?.ttfUrl).toBe("sourcesanspro-bold.ttf");
  });
});

describe("fontIdBackend", () => {
  it("maps the prefix to the source a content font-id comes from", () => {
    expect(fontIdBackend("gfont-inter")).toBe("google");
    expect(fontIdBackend("custom-1234")).toBe("custom");
    expect(fontIdBackend("sourcesanspro")).toBe("builtin");
    expect(fontIdBackend(undefined)).toBe("builtin");
    expect(fontIdBackend(42)).toBe("builtin");
  });
});

describe("customFontsToCatalog", () => {
  it("groups rows of one family under the custom-prefixed id", () => {
    const catalog = customFontsToCatalog([
      row({ "font-id": "abc", "font-weight": 400, "font-style": "normal" }),
      row({ id: "row-2", "font-id": "abc", "font-weight": 700, "font-style": "normal" }),
    ]);
    expect(catalog).toHaveLength(1);
    expect(catalog[0].id).toBe("custom-abc");
    expect(catalog[0].family).toBe("Inter");
    expect(catalog[0].backend).toBe("custom");
    expect(catalog[0].variants).toHaveLength(2);
  });

  it("gives a variant the <style>-<weight> id and the derived display name", () => {
    const catalog = customFontsToCatalog([
      row({ "font-id": "abc", "font-weight": 700, "font-style": "italic" }),
    ]);
    const variant = catalog[0].variants[0];
    expect(variant.id).toBe("italic-700");
    expect(variant.name).toBe("Bold Italic");
    expect(variant.weight).toBe("700");
    expect(variant.style).toBe("italic");
  });

  it("prefers a non-blank variant-name for the display label", () => {
    const catalog = customFontsToCatalog([
      row({ "font-id": "abc", "font-weight": 400, "variant-name": " Book " }),
    ]);
    expect(catalog[0].variants[0].name).toBe("Book");
  });

  it("sorts variants by weight, then normal before italic", () => {
    const catalog = customFontsToCatalog([
      row({ id: "a", "font-id": "abc", "font-weight": 700, "font-style": "normal" }),
      row({ id: "b", "font-id": "abc", "font-weight": 400, "font-style": "italic" }),
      row({ id: "c", "font-id": "abc", "font-weight": 400, "font-style": "normal" }),
    ]);
    const ids = catalog[0].variants.map((v) => v.id);
    expect(ids).toEqual(["normal-400", "italic-400", "normal-700"]);
  });
});

describe("buildFontsCatalog", () => {
  it("leads with the built-in family and appends the team fonts", () => {
    const catalog = buildFontsCatalog([row({ "font-id": "abc" })]);
    expect(catalog[0].id).toBe("sourcesanspro");
    expect(catalog[1].id).toBe("custom-abc");
  });

  it("copies the built-in variants so a caller cannot mutate the table", () => {
    const catalog = buildFontsCatalog([]);
    catalog[0].variants.push({ id: "extra", name: "x", weight: "100", style: "normal" });
    expect(BUILTIN_FONTS[0].variants).toHaveLength(12);
  });
});

describe("findCatalogFont / findCatalogVariant", () => {
  const catalog = buildFontsCatalog([]);

  it("resolves a known font-id and answers undefined for an unknown one", () => {
    expect(findCatalogFont(catalog, "sourcesanspro")?.id).toBe("sourcesanspro");
    expect(findCatalogFont(catalog, "custom-abc")).toBeUndefined();
    expect(findCatalogFont(catalog, undefined)).toBeUndefined();
  });

  it("matches a variant by id and falls back to the first for a stale id", () => {
    const font = findCatalogFont(catalog, "sourcesanspro")!;
    expect(findCatalogVariant(font, "bold")?.id).toBe("bold");
    expect(findCatalogVariant(font, "gone")?.id).toBe(font.variants[0].id);
    expect(findCatalogVariant(font, undefined)?.id).toBe(font.variants[0].id);
  });
});
