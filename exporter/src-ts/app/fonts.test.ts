import { afterEach, describe, expect, it } from "vitest";
import {
  buildCatalog,
  fontIdBackend,
  fontIdToUuid,
  gfontIdToUuid,
  setCatalog,
} from "./fonts.js";
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
