// Color encoding for the wasm ABI: the port of
// app.common.render-wasm.serializers.color/hex->u32argb.
//
// The renderer takes colors as unsigned 32-bit ARGB words. `<<` would make
// the value negative for any alpha above 0x7f, so every result goes through
// `>>> 0` once at the end — a negative colour reaching the artifact is read
// as unsigned there and would paint the wrong channels.
//
// Deviation from the compiled helper: the CLJS one parses `hex.slice(1)` and
// ignores the digit count, so a shorthand "#fff" becomes 0x00000FFF instead
// of white. The port expands 3/4-digit forms and accepts "#rrggbbaa", which
// is what every caller in the app actually means.

const ALPHA_MAX = 0xff;

function alphaByte(opacity: number): number {
  // CLJS `(or opacity 1)` keeps 0 (falsy in JS, truthy in CLJS), so only a
  // missing value falls back here.
  const value = Number.isFinite(opacity) ? opacity : 1;
  return Math.floor(value * ALPHA_MAX);
}

function expandShorthand(digits: string): string {
  return [...digits]
    .map((digit) => digit + digit)
    .join("");
}

export function hexToArgbU32(hex: string, opacity = 1): number {
  const digits = hex.replace(/^#/, "");

  if (digits.length === 3 || digits.length === 4) {
    return hexToArgbU32(`#${expandShorthand(digits)}`, opacity);
  }

  if (digits.length !== 6 && digits.length !== 8) {
    throw new Error(`render-wasm: cannot read the color "${hex}"`);
  }

  const rgb = Number.parseInt(digits.slice(0, 6), 16);
  if (Number.isNaN(rgb)) {
    throw new Error(`render-wasm: cannot read the color "${hex}"`);
  }

  const alpha =
    digits.length === 8 ? Number.parseInt(digits.slice(6), 16) : alphaByte(opacity);
  if (Number.isNaN(alpha)) {
    throw new Error(`render-wasm: cannot read the color "${hex}"`);
  }

  return ((alpha << 24) | rgb) >>> 0;
}