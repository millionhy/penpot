// opentype.js ships without bundled types: its package.json has no "types"
// field and dist/ carries no .d.ts. This declares the small surface the fonts
// code (app.main.data.fonts) uses — parse() plus the name getters and the
// hhea/os2 tables prepare() reads. Same shim pattern as types/transit-js.d.ts.

declare module "opentype.js" {
  export interface OpenTypeFontTables {
    // prepare() reads ascender/descender off hhea and the usWin/sTypo/fs
    // fields off os2. Parsed ttf/otf/woff fonts always carry both tables; the
    // optional markers keep a rare table-less font expressible instead of
    // crashing the type checker.
    hhea?: {
      ascender: number;
      descender: number;
    };
    os2?: {
      usWinAscent: number;
      usWinDescent: number;
      sTypoAscender: number;
      sTypoDescender: number;
      fsSelection: number;
    };
  }

  export interface OpenTypeFont {
    getEnglishName(name: string): string | undefined;
    tables: OpenTypeFontTables;
  }

  export function parse(
    buffer: ArrayBuffer | Uint8Array,
    options?: Record<string, unknown>,
  ): OpenTypeFont;
}
