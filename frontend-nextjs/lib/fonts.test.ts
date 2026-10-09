import { describe, expect, it } from "vitest";
import type { OpenTypeFont } from "opentype.js";
import {
  customFontCss,
  ensureLoaded,
  familyFromFilename,
  fontDisplayVariant,
  joinUploadedFonts,
  lookupCustomFont,
  mergeAndGroupFonts,
  parseFontMtype,
  parseFontStyle,
  parseFontWeight,
  processUpload,
  registerCustomFonts,
  renameAndRegroup,
  validFontFamily,
  type FontUploadItem,
  type FontVariantRow,
  type PreparedFont,
} from "@/lib/fonts";

// The four sfnt/woff signatures parse-mtype sniffs from the first bytes.
function bytes(values: number[]): ArrayBuffer {
  return new Uint8Array(values).buffer;
}
const TTF = bytes([0x00, 0x01, 0x00, 0x00]);
const OTF = bytes([0x4f, 0x54, 0x54, 0x4f]);
const WOFF = bytes([0x77, 0x4f, 0x46, 0x46]);
const WOFF2 = bytes([0x77, 0x4f, 0x46, 0x32]);

function fakeFile(name: string): File {
  return new File([new Uint8Array(8)], name);
}

// The opentype.js surface prepare-font uses: english names plus the metric
// tables. The cast keeps the test free of the real parser.
function mockFont(
  names: Record<string, string>,
  tables: Record<string, unknown> = {},
): OpenTypeFont {
  return {
    getEnglishName: (name: string) => names[name] ?? "",
    tables,
  } as unknown as OpenTypeFont;
}

function preparedFont(overrides: Partial<PreparedFont> = {}): PreparedFont {
  return {
    content: { data: new Uint8Array(new ArrayBuffer(1)), name: "acme.ttf", type: "font/ttf" },
    "font-family": "Acme",
    "font-weight": 400,
    "font-style": "normal",
    ...overrides,
  };
}

function uploadItem(overrides: Partial<FontUploadItem> = {}): FontUploadItem {
  return {
    id: "tmp-1",
    "team-id": "team-1",
    "font-family": "Acme",
    "font-weight": 400,
    "font-style": "normal",
    names: new Set(["acme.ttf"]),
    data: new Map([["font/ttf", new Uint8Array(new ArrayBuffer(1))]]),
    ...overrides,
  };
}

function row(overrides: Partial<FontVariantRow> = {}): FontVariantRow {
  return {
    id: "v1",
    "team-id": "team-1",
    "font-id": "f1",
    "font-family": "Acme",
    "font-weight": 400,
    "font-style": "normal",
    ...overrides,
  };
}

describe("familyFromFilename (the woff2 fallback)", () => {
  // The fixtures pin the exact token order of the CLJS regex, including the
  // quirk where a stripped token swallows the separator before "Italic".
  const cases: Array<[string, string]> = [
    ["Roboto Bold Italic", "Roboto Italic"],
    ["Roboto-Bold-Italic", "Roboto Italic"],
    ["RobotoBold.ttf", "RobotoBold"],
    ["Boldini-Regular", "Boldini"],
    ["My Font bold italic.ttf", "My Font italic"],
    ["foo_extra_black_italic.woff2", "foo extra italic"],
    ["bold-headline.ttf", "headline"],
    ["Roboto BoldBlack.woff2", "Roboto BoldBlack"],
    ["Roboto-thin.ttf", "Roboto"],
  ];

  it.each(cases)("strips the tokens of %s", (name, expected) => {
    expect(familyFromFilename(name)).toBe(expected);
  });

  it("falls back to the base name when everything was stripped", () => {
    expect(familyFromFilename("extra black.ttf")).toBe("extra black");
    expect(familyFromFilename("regular.ttf")).toBe("regular");
    expect(familyFromFilename("bold.ttf")).toBe("bold");
  });
});

describe("parseFontMtype", () => {
  it("reads the four signatures", () => {
    expect(parseFontMtype(OTF)).toBe("font/otf");
    expect(parseFontMtype(TTF)).toBe("font/ttf");
    expect(parseFontMtype(WOFF)).toBe("font/woff");
    expect(parseFontMtype(WOFF2)).toBe("font/woff2");
  });

  it("answers undefined for an unknown signature", () => {
    expect(parseFontMtype(bytes([1, 2, 3, 4]))).toBeUndefined();
  });
});

describe("parseFontWeight", () => {
  it("resolves the tokens in the CLJS order", () => {
    expect(parseFontWeight("Hairline")).toBe(100);
    expect(parseFontWeight("Thin")).toBe(100);
    expect(parseFontWeight("Extra Light")).toBe(200);
    expect(parseFontWeight("Light")).toBe(300);
    expect(parseFontWeight("Regular")).toBe(400);
    expect(parseFontWeight("Medium")).toBe(500);
    expect(parseFontWeight("Semi Bold")).toBe(600);
    expect(parseFontWeight("Demi Bold")).toBe(600);
    expect(parseFontWeight("Bold")).toBe(700);
    expect(parseFontWeight("Extra Bold")).toBe(800);
    expect(parseFontWeight("Black")).toBe(900);
    expect(parseFontWeight("Heavy")).toBe(900);
    expect(parseFontWeight("Solid")).toBe(900);
    expect(parseFontWeight("Extra Black")).toBe(950);
  });

  it("treats BoldItalic as a boundary and defaults to 400", () => {
    expect(parseFontWeight("BoldItalic")).toBe(700);
    expect(parseFontWeight("Roboto")).toBe(400);
    expect(parseFontWeight("Boldini")).toBe(400);
  });
});

describe("parseFontStyle", () => {
  it("matches italic on a boundary or at the end", () => {
    expect(parseFontStyle("Bold Italic")).toBe("italic");
    expect(parseFontStyle("Bold-Italic")).toBe("italic");
    expect(parseFontStyle("BoldItalic")).toBe("italic");
    expect(parseFontStyle("Bold")).toBe("normal");
    expect(parseFontStyle("Oblique")).toBe("normal");
  });
});

describe("fontDisplayVariant", () => {
  it("prefers the trimmed variant name", () => {
    expect(fontDisplayVariant(" Bold Italic ", 700, "italic")).toBe("Bold Italic");
  });

  it("falls back to the weight name and Italic", () => {
    expect(fontDisplayVariant(null, 400, "normal")).toBe("Regular");
    expect(fontDisplayVariant(undefined, 100, "normal")).toBe("Hairline");
    expect(fontDisplayVariant("  ", 700, "italic")).toBe("Bold Italic");
  });
});

describe("validFontFamily (schema:font-family)", () => {
  it("accepts letters, digits, spaces, _ - . and unicode letters", () => {
    expect(validFontFamily("Acme 2.0_Font-x")).toBe(true);
    expect(validFontFamily("字体")).toBe(true);
    expect(validFontFamily("a".repeat(250))).toBe(true);
  });

  it("rejects blank, over-long and special-character names", () => {
    expect(validFontFamily("")).toBe(false);
    expect(validFontFamily("   ")).toBe(false);
    expect(validFontFamily("bad@name")).toBe(false);
    expect(validFontFamily("a".repeat(251))).toBe(false);
  });
});

describe("joinUploadedFonts", () => {
  it("folds the same family, weight and style into one item", () => {
    const prepared = [
      preparedFont(),
      preparedFont({ content: { data: new Uint8Array(new ArrayBuffer(1)), name: "acme.woff", type: "font/woff" } }),
      preparedFont({ "font-style": "italic", content: { data: new Uint8Array(new ArrayBuffer(1)), name: "acme-i.woff2", type: "font/woff2" } }),
    ];
    let counter = 0;
    const joined = joinUploadedFonts(prepared, "team-1", () => "id-" + ++counter);
    expect([...joined.keys()]).toEqual(["id-1", "id-2"]);
    const first = joined.get("id-1")!;
    expect(first.data.size).toBe(2);
    expect([...first.names].sort()).toEqual(["acme.ttf", "acme.woff"]);
    expect(joined.get("id-2")!["font-style"]).toBe("italic");
  });
});

describe("mergeAndGroupFonts", () => {
  it("reuses the font-id of an installed family", () => {
    const installed = [row({ "font-family": "Acme", "font-id": "installed-a" })];
    const incoming = new Map([["tmp-1", uploadItem()]]);
    const merged = mergeAndGroupFonts(new Map(), installed, incoming, () => "fresh");
    expect(merged.get("tmp-1")!["font-id"]).toBe("installed-a");
  });

  it("mints one id per new family and reuses it within the batch", () => {
    const incoming = new Map([
      ["tmp-1", uploadItem({ id: "tmp-1", "font-family": "New" })],
      ["tmp-2", uploadItem({ id: "tmp-2", "font-family": "New" })],
    ]);
    const minted: string[] = [];
    const merged = mergeAndGroupFonts(new Map(), [], incoming, () => {
      const id = "fresh-" + (minted.length + 1);
      minted.push(id);
      return id;
    });
    expect(merged.get("tmp-1")!["font-id"]).toBe("fresh-1");
    expect(merged.get("tmp-2")!["font-id"]).toBe("fresh-1");
    expect(minted).toHaveLength(1);
  });

  it("keeps the id a queued item already carries", () => {
    const current = new Map([["tmp-0", uploadItem({ id: "tmp-0", "font-id": "queued-a" })]]);
    const incoming = new Map([["tmp-1", uploadItem({ id: "tmp-1" })]]);
    const merged = mergeAndGroupFonts(current, [], incoming, () => "fresh");
    expect(merged.get("tmp-1")!["font-id"]).toBe("queued-a");
  });
});

describe("renameAndRegroup", () => {
  it("keeps the installed id of the new name", () => {
    const installed = [row({ "font-family": "Beta", "font-id": "installed-b" })];
    const current = new Map([["tmp-1", uploadItem({ id: "tmp-1", "font-id": "queued-a" })]]);
    const renamed = renameAndRegroup(current, "tmp-1", "Beta", installed, () => "fresh");
    const item = renamed.get("tmp-1")!;
    expect(item["font-family"]).toBe("Beta");
    expect(item["font-id"]).toBe("installed-b");
  });

  it("mints a new id for an unknown name", () => {
    const current = new Map([["tmp-1", uploadItem({ id: "tmp-1", "font-id": "queued-a" })]]);
    const renamed = renameAndRegroup(current, "tmp-1", "Gamma", [], () => "fresh");
    expect(renamed.get("tmp-1")!["font-id"]).toBe("fresh");
  });
});

describe("processUpload", () => {
  it("reads every file once and joins the same family", async () => {
    const files = [fakeFile("Acme-Regular.ttf"), fakeFile("Acme-Regular.woff")];
    const reads: string[] = [];
    const { fonts, errors } = await processUpload(files, "team-1", {
      readBlob: (file) => {
        reads.push(file.name);
        return Promise.resolve(file.name.endsWith(".woff") ? WOFF : TTF);
      },
      parse: () => mockFont({ preferredFamily: "Acme", preferredSubfamily: "Regular" }),
      newId: () => "tmp-1",
    });
    expect(errors).toEqual([]);
    expect(reads).toEqual(["Acme-Regular.ttf", "Acme-Regular.woff"]);
    expect(fonts.size).toBe(1);
    const item = fonts.get("tmp-1")!;
    expect(item["font-family"]).toBe("Acme");
    expect(item["font-weight"]).toBe(400);
    expect(item["font-style"]).toBe("normal");
    expect(item["variant-name"]).toBe("Regular");
    expect(item.data.size).toBe(2);
    expect([...item.names].sort()).toEqual(["Acme-Regular.ttf", "Acme-Regular.woff"]);
  });

  it("compares the vertical metrics of the parsed tables", async () => {
    const aligned = {
      hhea: { ascender: 800, descender: -200 },
      os2: { usWinAscent: 800, usWinDescent: 200, fsSelection: 0 },
    };
    const ok = await processUpload([fakeFile("acme.ttf")], "team-1", {
      readBlob: () => Promise.resolve(TTF),
      parse: () => mockFont({ preferredFamily: "Acme", preferredSubfamily: "Regular" }, aligned),
      newId: () => "tmp-ok",
    });
    expect(ok.fonts.get("tmp-ok")!["height-warning"]).toBe(false);

    const winMismatch = {
      hhea: { ascender: 800, descender: -200 },
      os2: { usWinAscent: 810, usWinDescent: 200, fsSelection: 0 },
    };
    const warned = await processUpload([fakeFile("acme.ttf")], "team-1", {
      readBlob: () => Promise.resolve(TTF),
      parse: () => mockFont({ preferredFamily: "Acme", preferredSubfamily: "Regular" }, winMismatch),
      newId: () => "tmp-warn",
    });
    expect(warned.fonts.get("tmp-warn")!["height-warning"]).toBe(true);

    // Bit 7 of fsSelection switches the OS/2 typo pair into the comparison.
    const typoMismatch = {
      hhea: { ascender: 800, descender: -200 },
      os2: {
        usWinAscent: 800,
        usWinDescent: 200,
        fsSelection: 128,
        sTypoAscender: 820,
        sTypoDescender: -180,
      },
    };
    const typed = await processUpload([fakeFile("acme.ttf")], "team-1", {
      readBlob: () => Promise.resolve(TTF),
      parse: () => mockFont({ preferredFamily: "Acme", preferredSubfamily: "Regular" }, typoMismatch),
      newId: () => "tmp-typo",
    });
    expect(typed.fonts.get("tmp-typo")!["height-warning"]).toBe(true);
  });

  it("derives the woff2 metadata from the filename", async () => {
    const { fonts } = await processUpload([fakeFile("My Font bold italic.woff2")], "team-1", {
      readBlob: () => Promise.resolve(WOFF2),
      parse: () => {
        throw new Error("woff2 must not be parsed");
      },
      newId: () => "tmp-9",
    });
    const item = fonts.get("tmp-9")!;
    expect(item["font-family"]).toBe("My Font italic");
    expect(item["font-weight"]).toBe(700);
    expect(item["font-style"]).toBe("italic");
    expect(item["height-warning"]).toBe(false);
  });

  it("collects the quoted name of an unreadable file", async () => {
    const { fonts, errors } = await processUpload([fakeFile("broken.ttf")], "team-1", {
      readBlob: () => Promise.reject(new Error("io")),
      parse: () => {
        throw new Error("unreachable");
      },
    });
    expect(fonts.size).toBe(0);
    expect(errors).toEqual(["'broken.ttf'"]);
  });

  it("drops files with an unknown signature or a parser failure", async () => {
    const unknown = await processUpload([fakeFile("mystery.bin")], "team-1", {
      readBlob: () => Promise.resolve(bytes([1, 2, 3, 4])),
      parse: () => {
        throw new Error("unreachable");
      },
    });
    expect(unknown.fonts.size).toBe(0);
    expect(unknown.errors).toEqual([]);

    const rejected = await processUpload([fakeFile("acme.ttf")], "team-1", {
      readBlob: () => Promise.resolve(TTF),
      parse: () => {
        throw new Error("unsupported");
      },
    });
    expect(rejected.fonts.size).toBe(0);
    expect(rejected.errors).toEqual([]);
  });
});

describe("registerCustomFonts / customFontCss", () => {
  it("groups the rows per font and sorts the variants", () => {
    registerCustomFonts([
      row({ id: "v1", "font-id": "f1", "font-weight": 700, "font-style": "italic" }),
      row({ id: "v2", "font-id": "f1", "font-weight": 400, "font-style": "normal" }),
      row({ id: "v3", "font-id": "f2", "font-family": "Beta" }),
    ]);
    const font = lookupCustomFont("custom-f1");
    expect(font).toBeDefined();
    expect(font!.family).toBe("Acme");
    expect(font!.variants.map((variant) => variant.id)).toEqual(["normal-400", "italic-700"]);
    expect(lookupCustomFont("custom-f2")!.variants).toHaveLength(1);
  });

  it("writes the @font-face template the loader injects", () => {
    registerCustomFonts([row({ id: "v1", "font-id": "f1", "woff1-file-id": "file-1" })]);
    const css = customFontCss(lookupCustomFont("custom-f1")!, "");
    expect(css).toBe(
      "@font-face {\n" +
        "    font-family: 'Acme';\n" +
        "    font-style: normal;\n" +
        "    font-weight: 400;\n" +
        "    font-display: block;\n" +
        "    src: url(/assets/by-id/file-1) format('woff');\n" +
        "  }",
    );
  });
});

describe("ensureLoaded", () => {
  it("is a no-op without a document", () => {
    expect(() => ensureLoaded("custom-f1")).not.toThrow();
    expect(() => ensureLoaded("unknown-font")).not.toThrow();
  });
});
