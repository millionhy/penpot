import { afterEach, describe, expect, it } from "vitest";
import {
  addEmojiFont,
  addNotoFonts,
  buildCatalog,
  closestVariant,
  collectUsedLanguages,
  containsEmoji,
  fontIdBackend,
  fontIdToUuid,
  gfontByUuid,
  gfontIdToUuid,
  gstaticToProxyUrl,
  notoFonts,
  resolveTtfFile,
  resolveTtfUrl,
  setCatalog,
} from "./fonts.js";
import type { GFont } from "./fonts.js";
import { zero } from "./uuid.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

afterEach(() => {
  setCatalog(undefined);
});

describe("fonts", () => {
  it("classifies a font-id by its source", () => {
    expect(fontIdBackend("gfont-noto-sans-jp")).toBe("google");
    expect(fontIdBackend("custom-11111111-2222-3333-4444-555555555555")).toBe("custom");
    expect(fontIdBackend("sourcesanspro")).toBe("builtin");
    expect(fontIdBackend(undefined)).toBe("builtin");
  });

  it("gives every catalog family one uuid built from its slug", () => {
    const catalog = buildCatalog([
      {
        family: "Noto Sans JP",
        variants: ["regular", "italic", "600", "600italic"],
        files: {
          regular: "https://example/regular.ttf",
          italic: "https://example/italic.ttf",
          600: "https://example/600.ttf",
        },
      },
    ]);
    setCatalog(catalog);

    const entry = catalog.get("gfont-noto-sans-jp");
    expect(entry).toBeDefined();
    expect(entry?.family).toBe("Noto Sans JP");
    expect(entry?.uuid).toMatch(UUID_RE);
    expect(entry?.variants).toEqual([
      { id: "regular", name: "400", weight: 400, style: "normal", "ttf-url": "https://example/regular.ttf" },
      { id: "italic", name: "400 Italic", weight: 400, style: "italic", "ttf-url": "https://example/italic.ttf" },
      { id: "600", name: "600", weight: 600, style: "normal", "ttf-url": "https://example/600.ttf" },
      { id: "600", name: "600 Italic", weight: 600, style: "italic", "ttf-url": "https://example/600.ttf" },
    ]);
    expect(gfontIdToUuid("gfont-noto-sans-jp")).toBe(entry?.uuid);
    expect(fontIdToUuid("gfont-noto-sans-jp")).toBe(entry?.uuid);
  });

  it("keeps one uuid per family across calls", () => {
    setCatalog(buildCatalog([{ family: "ABeeZee", variants: ["regular"], files: { regular: "u" } }]));
    const first = fontIdToUuid("gfont-abeezee");
    expect(first).toMatch(UUID_RE);
    expect(fontIdToUuid("gfont-abeezee")).toBe(first);
  });

  it("passes custom uuids through and maps the rest to uuid/zero", () => {
    const custom = "11111111-2222-3333-4444-555555555555";
    expect(fontIdToUuid(`custom-${custom}`)).toBe(custom);
    expect(fontIdToUuid("custom-not-a-uuid")).toBe(zero);
    expect(fontIdToUuid("sourcesanspro")).toBe(zero);
    expect(fontIdToUuid("gfont-unknown-family")).toBe(zero);
    expect(fontIdToUuid(null)).toBe(zero);
  });
});

function catalog(): Map<string, GFont> {
  return buildCatalog([
    {
      family: "Noto Sans",
      variants: ["regular", "italic", "600"],
      files: {
        regular: "https://fonts.gstatic.com/s/notosans/regular.ttf",
        italic: "https://fonts.gstatic.com/s/notosans/italic.ttf",
        600: "https://fonts.gstatic.com/s/notosans/600.ttf",
      },
    },
  ]);
}

describe("reverse lookup", () => {
  it("finds the catalog entry a uuid belongs to", () => {
    const entries = catalog();
    setCatalog(entries);

    const uuid = gfontIdToUuid("gfont-noto-sans");
    expect(gfontByUuid(String(uuid))).toBe(entries.get("gfont-noto-sans"));
    expect(gfontByUuid(zero)).toBeUndefined();
  });
});

describe("gstaticToProxyUrl", () => {
  it("points a gstatic url at the proxy", () => {
    expect(
      gstaticToProxyUrl(
        "https://fonts.gstatic.com/s/notosans/v1/regular.ttf",
        "http://backend:6060/internal/gfonts/font/",
      ),
    ).toBe("http://backend:6060/internal/gfonts/font/notosans/v1/regular.ttf");
  });

  it("leaves a non-gstatic url alone", () => {
    const url = "https://fonts.example/regular.ttf";
    expect(gstaticToProxyUrl(url, "http://backend:6060/internal/gfonts/font")).toBe(url);
  });
});

describe("closestVariant", () => {
  const variants = [
    { weight: 400, style: "normal", "ttf-url": "r" },
    { weight: 400, style: "italic", "ttf-url": "i" },
    { weight: 700, style: "normal", "ttf-url": "b" },
  ];

  it("takes the exact weight and style", () => {
    expect(closestVariant(variants, 700, "normal")).toBe(variants[2]);
  });

  it("keeps the weight when only the style is missing", () => {
    expect(closestVariant(variants, 400, "italic")).toBe(variants[1]);
  });

  it("takes the nearest weight, preferring the heavier one on a tie", () => {
    expect(closestVariant(variants, 500, "normal")).toBe(variants[0]);
    expect(closestVariant(variants, 550, "normal")).toBe(variants[2]);
    expect(closestVariant(variants, 300, "normal")).toBe(variants[0]);
  });

  it("accepts a string weight and rejects a malformed one", () => {
    expect(closestVariant(variants, "600", "normal")).toBe(variants[2]);
    expect(closestVariant(variants, "bold", "normal")).toBeUndefined();
  });
});

describe("ttf resolution", () => {
  it("resolves the catalog url for the requested variant", () => {
    setCatalog(catalog());
    const uuid = String(gfontIdToUuid("gfont-noto-sans"));

    expect(resolveTtfUrl(uuid, 600, 0)).toBe("https://fonts.gstatic.com/s/notosans/600.ttf");
    expect(resolveTtfUrl(uuid, 400, 1)).toBe("https://fonts.gstatic.com/s/notosans/italic.ttf");
    expect(resolveTtfUrl(zero, 400, 0)).toBeUndefined();
  });

  it("resolves the bundled family by nearest weight", () => {
    expect(resolveTtfFile(400, 0)).toBe("sourcesanspro-regular.ttf");
    expect(resolveTtfFile(700, 0)).toBe("sourcesanspro-bold.ttf");
    expect(resolveTtfFile(400, 1)).toBe("sourcesanspro-italic.ttf");
    // 500 sits between 400 and 600; 600 is the nearer one.
    expect(resolveTtfFile(500, 0)).toBe("sourcesanspro-semibold.ttf");
  });
});

describe("fallback fonts", () => {
  it("detects emoji in text", () => {
    expect(containsEmoji("hello \u{1F600}")).toBe(true);
    expect(containsEmoji("hello")).toBe(false);
  });

  it("collects the scripts a text uses", () => {
    let used = new Set<string>();
    used = collectUsedLanguages(used, "\u3053\u3093\u306B\u3061\u306F");
    used = collectUsedLanguages(used, "\u4F60\u597D");

    expect([...used]).toEqual(expect.arrayContaining(["japanese", "chinese"]));
    expect(collectUsedLanguages(used, "plain latin").has("japanese")).toBe(true);
  });

  it("maps each language to its noto family", () => {
    const fonts = addNotoFonts([], ["japanese", "arabic", "unknown"]);

    expect(fonts.map((font) => font["font-id"])).toEqual([
      "gfont-noto-sans-jp",
      "gfont-noto-sans-arabic",
    ]);
    expect(fonts.every((font) => font["is-fallback"])).toBe(true);
    expect(notoFonts.chinese["font-id"]).toBe("gfont-noto-sans-sc");
  });

  it("appends the emoji family as a fallback", () => {
    const fonts = addEmojiFont(addNotoFonts([], ["japanese"]));

    expect(fonts).toHaveLength(2);
    expect(fonts[1]).toMatchObject({ "font-id": "gfont-noto-color-emoji", "is-emoji": true });
  });
});
