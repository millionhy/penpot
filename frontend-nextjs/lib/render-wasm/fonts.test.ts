import { describe, expect, it } from "vitest";

import {
  BUILTIN_FONTS,
  ZERO_UUID,
  builtinTtfUrl,
  closestVariant,
  customTtfUrl,
  fontIdToBackend,
  fontIdToUuid,
  normalizeVariantId,
  resolveFontFace,
  serializeFontStyle,
  serializeFontWeight,
} from "./fonts";

describe("fontIdToBackend", () => {
  it("maps the id prefixes to the three buckets", () => {
    expect(fontIdToBackend("gfont-noto-sans")).toBe("google");
    expect(fontIdToBackend("custom-ad9d5693-49bf-81be-8008-dde80b1438d6")).toBe("custom");
    expect(fontIdToBackend("sourcesanspro")).toBe("builtin");
    expect(fontIdToBackend(undefined)).toBe("builtin");
    expect(fontIdToBackend("")).toBe("builtin");
  });
});

describe("fontIdToUuid", () => {
  it("parses the custom-<uuid> suffix, lowercased", () => {
    expect(fontIdToUuid("custom-AD9D5693-49BF-81BE-8008-DDE80B1438D6")).toBe(
      "ad9d5693-49bf-81be-8008-dde80b1438d6",
    );
  });
  it("falls back to zero for a malformed custom suffix", () => {
    expect(fontIdToUuid("custom-not-a-uuid")).toBe(ZERO_UUID);
  });
  it("maps builtin and google (catalog unsupported here) to zero", () => {
    expect(fontIdToUuid("sourcesanspro")).toBe(ZERO_UUID);
    expect(fontIdToUuid("gfont-noto-sans")).toBe(ZERO_UUID);
  });
});

describe("serializeFontWeight", () => {
  it("passes numbers and numeric strings through", () => {
    expect(serializeFontWeight(700)).toBe(700);
    expect(serializeFontWeight("400")).toBe(400);
  });
  it("reads the named weights like the CLJS table", () => {
    expect(serializeFontWeight("bold")).toBe(700);
    expect(serializeFontWeight("extralight")).toBe(200);
    expect(serializeFontWeight("black")).toBe(900);
    // Faithful to the CLJS `cond`, which tests includes? "bold" (700) before
    // "semibold"/"extrabold": "semibold" and "extrabold" both contain "bold"
    // so they resolve to 700, not 600/800. Parity, not a porting slip.
    expect(serializeFontWeight("semibold")).toBe(700);
    expect(serializeFontWeight("extrabold")).toBe(700);
  });
  it("defaults to 400", () => {
    expect(serializeFontWeight(undefined)).toBe(400);
    expect(serializeFontWeight("")).toBe(400);
  });
});

describe("serializeFontStyle", () => {
  it("0 for normal/regular/unknown, 1 for italic", () => {
    expect(serializeFontStyle("normal")).toBe(0);
    expect(serializeFontStyle("regular")).toBe(0);
    expect(serializeFontStyle(undefined)).toBe(0);
    expect(serializeFontStyle("italic")).toBe(1);
  });
});

describe("normalizeVariantId", () => {
  it("lowercases and strips whitespace", () => {
    expect(normalizeVariantId("Bold Italic")).toBe("bolditalic");
    expect(normalizeVariantId(undefined)).toBe("");
  });
});

describe("closestVariant", () => {
  const variants = BUILTIN_FONTS[0].variants;
  it("returns null when the weight does not parse", () => {
    expect(closestVariant(variants, "abc", "normal")).toBeNull();
  });
  it("prefers the higher weight on an exact tie", () => {
    // No 500 face: 400 and 600 are both 100 away, so 600 wins.
    const result = closestVariant(variants, 500, "normal");
    expect(result?.weight).toBe("600");
  });
  it("exact weight + style match wins immediately", () => {
    const result = closestVariant(variants, 400, "italic");
    expect(result?.style).toBe("italic");
    expect(result?.weight).toBe("400");
  });
});

describe("resolveFontFace — builtin", () => {
  it("resolves the default regular face to the zero uuid + a fonts/ URL", () => {
    const outcome = resolveFontFace({ fontId: "sourcesanspro", fontVariantId: "regular" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.face.backend).toBe("builtin");
    expect(outcome.face.familyUuid).toBe(ZERO_UUID);
    expect(outcome.face.weight).toBe(400);
    expect(outcome.face.style).toBe(0);
    expect(outcome.face.ttfUrl).toBe("/fonts/sourcesanspro-regular.ttf");
  });
  it("honours an explicit publicUri prefix", () => {
    const outcome = resolveFontFace(
      { fontId: "sourcesanspro", fontVariantId: "bold" },
      { publicUri: "https://penpot.example" },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.face.weight).toBe(700);
    expect(outcome.face.ttfUrl).toBe("https://penpot.example/fonts/sourcesanspro-bold.ttf");
  });
  it("detects an italic variant from the variant id", () => {
    const outcome = resolveFontFace({ fontId: "sourcesanspro", fontVariantId: "italic" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.face.style).toBe(1);
    expect(outcome.face.weight).toBe(400);
  });
  it("defaults an absent variant id to regular", () => {
    const outcome = resolveFontFace({ fontId: "sourcesanspro" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.face.ttfUrl).toBe("/fonts/sourcesanspro-regular.ttf");
  });
});

describe("resolveFontFace — custom", () => {
  it("uses the injected variant row + an assets/by-id URL", () => {
    const outcome = resolveFontFace(
      { fontId: "custom-ad9d5693-49bf-81be-8008-dde80b1438d6" },
      { customVariant: { weight: 700, style: "normal", ttfFileId: "file-123" } },
    );
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.face.backend).toBe("custom");
    expect(outcome.face.familyUuid).toBe("ad9d5693-49bf-81be-8008-dde80b1438d6");
    expect(outcome.face.wasmIdWords).toHaveLength(4);
    expect(outcome.face.weight).toBe(700);
    expect(outcome.face.ttfUrl).toBe("/assets/by-id/file-123");
  });
  it("reports a missing ttf file as custom-missing-file", () => {
    const outcome = resolveFontFace(
      { fontId: "custom-ad9d5693-49bf-81be-8008-dde80b1438d6" },
      { customVariant: { weight: 400, style: "normal" } },
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe("custom-missing-file");
  });
});

describe("resolveFontFace — google", () => {
  it("is recognised but reported unsupported in this milestone", () => {
    const outcome = resolveFontFace({ fontId: "gfont-noto-sans" });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe("google-unsupported");
  });
});

describe("url helpers", () => {
  it("join a relative base without a trailing slash", () => {
    expect(builtinTtfUrl("x.ttf", "")).toBe("/fonts/x.ttf");
    expect(builtinTtfUrl("x.ttf", "https://h/")).toBe("https://h/fonts/x.ttf");
    expect(customTtfUrl("f", "https://h")).toBe("https://h/assets/by-id/f");
  });
});
